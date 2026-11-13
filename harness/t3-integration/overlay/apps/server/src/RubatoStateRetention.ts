/**
 * Keeps the GUI server's state database bounded on T3's V2 orchestrator (state-retention-edits.mjs).
 * Upstream keeps every event and command receipt and never calls its own compaction, and
 * statev2.sqlite starts as a full copy of the V1 database (initializeV2Database.ts). The V1 file
 * grew ~150MB a day before Rubato pruned it.
 *
 * What goes, and why nothing shown or replayed needs it:
 * - What upstream's own compaction (ProjectionMaintenanceV2.compactEventStore) removes: thread-state
 *   events a newer one of the same thread supersedes, older versions of a message or node, and the
 *   V1 events and receipts of threads whose V1 transcript V2 has already imported.
 * - `turn-item.updated` events older than RETENTION.eventDays that a newer update of the same
 *   item supersedes. The projection replaces an item's whole row on every update (upsertById,
 *   ProjectionStore apply) and every update carries the item's ordinal, so the newest update
 *   alone rebuilds the same row at the same position. A subagent row stores its prompt once and
 *   later rows point at it (`promptSequence`, OrchestrationEventStore appendAgentEvents); a row
 *   any row has pointed at stays. Upstream leaves these events alone; they are most of what a
 *   long tool-heavy conversation writes.
 * - V2 command receipts older than RETENTION.receiptDays. A receipt answers "was this command
 *   handled already" for a retry seconds or minutes later; nothing replays from it.
 * - Rows of the copied V1 tables nothing on V2 reads (UNREAD_V1_TABLES). The lazy V1 import
 *   reads V1 threads, messages and pull requests; the V1 work log, turns and diff blobs are
 *   never read again. The V1 state.sqlite beside this file keeps its own copy.
 *
 * How, without reading the whole history: upstream's compaction and the first version of this
 * file paged every event newest first on every pass, about 3GB for 750k events, and the server
 * answered nothing meanwhile because it has one SQLite connection and node:sqlite blocks the event
 * loop while a statement runs. A pass now reads only the events written since the last one
 * (`walked`) and the item updates that crossed the age line since then (`aged`). The newest event
 * of each superseded kind is remembered (rubato_retention_newest), so a newer one removes it by
 * sequence; an item update still too young to go stays until the age walk reaches it. The first
 * pass reads everything once. Every page is its own short transaction, and the pass rests as long
 * as each page took, so it never holds more than half of the server's time.
 *
 * Freed pages go back to the disk: the file is switched to incremental auto-vacuum once (one
 * VACUUM, before the server serves), and every pass hands its free pages back. The planner's
 * statistics are sampled again before the server serves and after every pass. A step that fails
 * is logged and the others and later passes still run.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { forkParked } from "./serverActivation.ts";

export const RETENTION = {
  eventDays: 3,
  receiptDays: 3,
  interval: Duration.hours(6),
  /** Let the initial window and its history load before competing for the writer connection. */
  startupDelay: Duration.seconds(30),
  /** Rows one statement may touch. */
  chunk: 500,
  /** Rows of each index a statistics refresh samples. */
  analysisRows: 400,
  /** Free pages one incremental_vacuum transaction returns to the disk. */
  vacuumPages: 2000,
  pause: Duration.millis(5),
} as const;

/** Copied V1 tables V2 never reads (checked against v0.1.0's apps/server sources). */
export const UNREAD_V1_TABLES = ["projection_thread_activities", "projection_turns", "checkpoint_diff_blobs"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_VACUUM_INCREMENTAL = 2;

export interface RetentionReport {
  readonly compactedEvents: number;
  readonly supersededTurnItems: number;
  readonly legacyEvents: number;
  readonly legacyReceipts: number;
  readonly receipts: number;
  readonly v1Rows: number;
  readonly freedPages: number;
}

/**
 * Thread-state events whose payload is the whole thread: only the newest of a thread counts.
 * Upstream's list (ProjectionMaintenance.ts SUPERSEDABLE_THREAD_EVENT_TYPES); a type upstream adds
 * later is kept here until it is added, which only keeps more rows.
 */
export const THREAD_STATE_EVENTS = [
  "thread.archived", "thread.unarchived", "thread.deleted", "thread.settled", "thread.unsettled",
  "thread.snoozed", "thread.unsnoozed", "thread.pinned", "thread.auto-settle-set", "thread.unpinned",
  "thread.pin-reordered", "thread.active-reordered", "thread.metadata-updated", "thread.pull-request-synced",
  "thread.runtime-mode-updated", "thread.interaction-mode-updated", "thread.model-selection-updated",
  "thread.provider-switched", "thread.visited", "thread.marked-unread",
] as const;
/** Versions of one message or node: only the newest counts (upstream compaction too). */
const ENTITY_EVENTS = ["message.updated", "node.updated"] as const;
const TURN_ITEM_EVENT = "turn-item.updated";
const THREAD_STATE = new Set<string>(THREAD_STATE_EVENTS);
const ENTITY = new Set<string>(ENTITY_EVENTS);
/** The key a thread-state event is remembered under: one per thread, whatever its type. */
const THREAD_STATE_KIND = "thread-state";

function changesOf(result: unknown): number {
  if (result === null || typeof result !== "object" || !("changes" in result)) return 0;
  const changes = Number(result.changes);
  return Number.isFinite(changes) ? changes : 0;
}
const isoBefore = (nowMs: number, days: number) => DateTime.formatIso(DateTime.makeUnsafe(nowMs - days * DAY_MS));

/** Repeats a LIMITed statement until it touches fewer rows than the limit. */
const untilShort = (statement: Effect.Effect<number, SqlError>) =>
  Effect.gen(function* () {
    let total = 0;
    for (;;) {
      const changes = yield* statement;
      total += changes;
      if (changes < RETENTION.chunk) return total;
      yield* Effect.sleep(RETENTION.pause);
    }
  });

export const pruneUnreadV1Tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let total = 0;
  for (const table of UNREAD_V1_TABLES) {
    const exists = yield* sql<{ readonly found: number }>`
      SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if ((exists[0]?.found ?? 0) === 0) continue;
    total += yield* untilShort(sql`
      DELETE FROM ${sql(table)} WHERE rowid IN (SELECT rowid FROM ${sql(table)} LIMIT ${RETENTION.chunk})
    `.raw.pipe(Effect.map(changesOf)));
  }
  return total;
});

export const pruneReceipts = Effect.fn("RubatoStateRetention.pruneReceipts")(function* (nowMs: number) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.receiptDays);
  return yield* untilShort(sql`
    DELETE FROM orchestration_command_receipts WHERE rowid IN (
      SELECT rowid FROM orchestration_command_receipts
      WHERE command_type <> 'legacy' AND accepted_at < ${cutoff}
      LIMIT ${RETENTION.chunk})
  `.raw.pipe(Effect.map(changesOf)));
});

/** Where the last pass got to, and the newest event of every superseded kind it has seen. */
export const ensureRetentionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS rubato_retention_marks (name TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS rubato_retention_newest (
    kind TEXT NOT NULL, stream_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL,
    PRIMARY KEY (kind, stream_id, entity_id)) WITHOUT ROWID`;
  // Rows a subagent update points its prompt at. They stay: a later row may point at one again.
  yield* sql`CREATE TABLE IF NOT EXISTS rubato_retention_anchors (sequence INTEGER PRIMARY KEY)`;
});

const readMark = (name: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly value: string }>`SELECT value FROM rubato_retention_marks WHERE name = ${name}`;
  return rows[0]?.value;
});
const writeMark = (name: string, value: string | number) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO rubato_retention_marks (name, value) VALUES (${name}, ${String(value)})
    ON CONFLICT (name) DO UPDATE SET value = excluded.value`;
});

/** Rests as long as the step took, so retention holds at most half of the server's time. */
const pace = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const [elapsed, value] = yield* Effect.timed(effect);
  yield* Effect.sleep(Duration.max(elapsed, RETENTION.pause));
  return value;
});

/** The last event written at least `cutoff` ago, searched by sequence (events are written in time order). */
const sequenceBefore = (cutoff: string, low: number, high: number) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = (sequence: number) => sql<{ readonly sequence: number; readonly occurred_at: string }>`
    SELECT sequence, occurred_at FROM orchestration_events WHERE sequence >= ${sequence} ORDER BY sequence LIMIT 1`;
  let found = low;
  let from = low + 1;
  let to = high;
  while (from <= to) {
    const middle = Math.floor((from + to) / 2);
    const row = (yield* at(middle))[0];
    if (row === undefined || row.sequence > high) { to = middle - 1; continue; }
    if (row.occurred_at < cutoff) { found = row.sequence; from = row.sequence + 1; }
    else to = middle - 1;
  }
  return found;
});

interface Newest { readonly sequence: number; readonly occurred_at: string }
const keyOf = (kind: string, streamId: string, entityId: string) => `${kind}\u0000${streamId}\u0000${entityId}`;

/**
 * Removes superseded events written since the last pass and item updates that aged past the line
 * since then. Equal to paging the whole history with upstream's rules and the turn-item rule,
 * except that a row a subagent update once pointed at always stays.
 */
export const compactEvents = Effect.fn("RubatoStateRetention.compactEvents")(function* (nowMs: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRetentionTables;
  const cutoff = isoBefore(nowMs, RETENTION.eventDays);
  const top = yield* sql<{ readonly last: number | null }>`SELECT MAX(sequence) AS last FROM orchestration_events`;
  const through = Number(top[0]?.last ?? 0);
  const walkedMark = yield* readMark("walked");
  const agedMark = yield* readMark("aged");
  let walked = Number(walkedMark ?? 0);
  let compactedEvents = 0;
  let supersededTurnItems = 0;

  const newest = (kind: string, streamId: string, entityId: string) => sql<Newest>`
    SELECT sequence, occurred_at FROM rubato_retention_newest
    WHERE kind = ${kind} AND stream_id = ${streamId} AND entity_id = ${entityId}`.pipe(Effect.map((rows) => rows[0]));
  const isAnchor = (sequence: number) => sql<{ readonly sequence: number }>`
    SELECT sequence FROM rubato_retention_anchors WHERE sequence = ${sequence}`.pipe(Effect.map((rows) => rows.length > 0));
  const remove = (sequences: ReadonlyArray<number>) => sequences.length === 0 ? Effect.succeed(0)
    : sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(sequences)}`.raw.pipe(Effect.map(changesOf));

  // Events written since the last pass, oldest first: each one supersedes the newest one before it.
  while (walked < through) {
    yield* pace(sql.withTransaction(Effect.gen(function* () {
      const rows = yield* sql<{
        readonly sequence: number; readonly event_type: string; readonly stream_id: string; readonly occurred_at: string;
        readonly entity_id: string | null; readonly prompt_sequence: number | null;
      }>`
        SELECT sequence, event_type, stream_id, occurred_at,
          CASE WHEN event_type IN ('message.updated', 'node.updated', 'turn-item.updated')
            THEN json_extract(payload_json, '$.id') END AS entity_id,
          CASE WHEN event_type = 'turn-item.updated' AND json_type(payload_json, '$.promptSequence') = 'integer'
            THEN json_extract(payload_json, '$.promptSequence') END AS prompt_sequence
        FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND sequence > ${walked} AND sequence <= ${through}
        ORDER BY sequence
        LIMIT ${RETENTION.chunk}
      `;
      const anchors = new Set<number>();
      for (const row of rows) if (row.prompt_sequence !== null) anchors.add(Number(row.prompt_sequence));
      for (const anchor of anchors) yield* sql`INSERT OR IGNORE INTO rubato_retention_anchors (sequence) VALUES (${anchor})`;
      const seen = new Map<string, Newest | undefined>();
      const changed = new Map<string, { kind: string; streamId: string; entityId: string; row: Newest }>();
      const superseded: Array<number> = [];
      const oldItems: Array<number> = [];
      for (const row of rows) {
        const kind = THREAD_STATE.has(row.event_type) ? THREAD_STATE_KIND
          : ENTITY.has(row.event_type) || row.event_type === TURN_ITEM_EVENT ? row.event_type : undefined;
        if (kind === undefined || (kind !== THREAD_STATE_KIND && row.entity_id === null)) continue;
        const entityId = kind === THREAD_STATE_KIND ? "" : String(row.entity_id);
        const key = keyOf(kind, row.stream_id, entityId);
        const previous = seen.has(key) ? seen.get(key) : yield* newest(kind, row.stream_id, entityId);
        if (previous !== undefined) {
          // An item update younger than the age line waits for the age walk.
          if (kind !== TURN_ITEM_EVENT) superseded.push(previous.sequence);
          else if (previous.occurred_at < cutoff && !anchors.has(previous.sequence) && !(yield* isAnchor(previous.sequence)))
            oldItems.push(previous.sequence);
        }
        const next = { sequence: row.sequence, occurred_at: row.occurred_at };
        seen.set(key, next);
        changed.set(key, { kind, streamId: row.stream_id, entityId, row: next });
      }
      for (const { kind, streamId, entityId, row } of changed.values()) yield* sql`
        INSERT INTO rubato_retention_newest (kind, stream_id, entity_id, sequence, occurred_at)
        VALUES (${kind}, ${streamId}, ${entityId}, ${row.sequence}, ${row.occurred_at})
        ON CONFLICT (kind, stream_id, entity_id) DO UPDATE SET sequence = excluded.sequence, occurred_at = excluded.occurred_at`;
      compactedEvents += yield* remove(superseded);
      supersededTurnItems += yield* remove(oldItems);
      walked = rows.length < RETENTION.chunk ? through : rows.at(-1)!.sequence;
      yield* writeMark("walked", walked);
    })));
  }

  // Item updates that crossed the age line since the last pass: one a newer update supersedes goes.
  // A first pass decided every row with today's line already, so it only records where that is.
  const agedThrough = yield* sequenceBefore(cutoff, Number(agedMark ?? 0), walked);
  let aged = agedMark === undefined ? agedThrough : Number(agedMark);
  while (aged < agedThrough) {
    yield* pace(sql.withTransaction(Effect.gen(function* () {
      const rows = yield* sql<{ readonly sequence: number; readonly stream_id: string; readonly entity_id: string | null }>`
        SELECT sequence, stream_id, json_extract(payload_json, '$.id') AS entity_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND event_type = 'turn-item.updated'
          AND sequence > ${aged} AND sequence <= ${agedThrough} AND occurred_at < ${cutoff}
        ORDER BY sequence
        LIMIT ${RETENTION.chunk}
      `;
      const old: Array<number> = [];
      for (const row of rows) {
        if (row.entity_id === null) continue;
        const kept = yield* newest(TURN_ITEM_EVENT, row.stream_id, String(row.entity_id));
        if (kept !== undefined && kept.sequence !== row.sequence && !(yield* isAnchor(row.sequence))) old.push(row.sequence);
      }
      supersededTurnItems += yield* remove(old);
      aged = rows.length < RETENTION.chunk ? agedThrough : rows.at(-1)!.sequence;
      yield* writeMark("aged", aged);
    })));
  }
  if (agedMark === undefined) yield* writeMark("aged", aged);
  return { compactedEvents, supersededTurnItems };
});

/**
 * Upstream's rule for V1 history: once V2 imported a V1 thread's transcript, its V1 events and
 * legacy receipts are not read again. Only threads imported since the last pass are visited.
 */
export const pruneImportedLegacy = Effect.fn("RubatoStateRetention.pruneImportedLegacy")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRetentionTables;
  const since = (yield* readMark("legacy")) ?? "";
  const imported = yield* sql<{ readonly thread_id: string; readonly transcript_imported_at: string }>`
    SELECT thread_id, transcript_imported_at FROM orchestration_v2_legacy_imports
    WHERE transcript_imported_at IS NOT NULL AND transcript_imported_at > ${since}
    ORDER BY transcript_imported_at`;
  let events = 0;
  let receipts = 0;
  for (const thread of imported) {
    yield* pace(sql.withTransaction(Effect.gen(function* () {
      events += changesOf(yield* sql`DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${thread.thread_id} AND application_event_version = 1`.raw);
      receipts += changesOf(yield* sql`DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = ${thread.thread_id} AND command_type = 'legacy'`.raw);
      yield* writeMark("legacy", thread.transcript_imported_at);
    })));
  }
  return { events, receipts };
});

export const autoVacuumMode = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  return Number(rows[0]?.auto_vacuum ?? 0);
});

/** Returns free pages to the disk; only works once the file is INCREMENTAL. */
export const releaseFreePages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* autoVacuumMode) !== AUTO_VACUUM_INCREMENTAL) return 0;
  let freed = 0;
  for (;;) {
    const rows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const free = Number(rows[0]?.freelist_count ?? 0);
    if (free === 0) return freed;
    // node:sqlite steps a statement without result columns once, and one step of
    // incremental_vacuum frees one page: one statement per page, in one transaction.
    const pages = Math.min(free, RETENTION.vacuumPages);
    yield* sql.withTransaction(Effect.gen(function* () {
      for (let page = 0; page < pages; page += 1) yield* sql.unsafe("PRAGMA incremental_vacuum(1)").raw;
    }));
    const after = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const left = Number(after[0]?.freelist_count ?? 0);
    if (left >= free) return freed;
    freed += free - left;
    yield* Effect.sleep(RETENTION.pause);
  }
});

/** Switches the file to incremental auto-vacuum: one VACUUM, outside any transaction. */
export const compactOnce = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* autoVacuumMode) === AUTO_VACUUM_INCREMENTAL) return false;
  const [elapsed] = yield* Effect.timed(Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL").raw;
    yield* sql.unsafe("VACUUM").raw;
    // VACUUM goes through the WAL; give that space back now too.
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)").raw;
  }));
  yield* Effect.logInfo("state database compacted", { durationMs: Duration.toMillis(elapsed) });
  return true;
});

const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, fallback: A) =>
  effect.pipe(Effect.catchCause((cause) =>
    Effect.logWarning("state retention step failed", { step: name, cause }).pipe(Effect.as(fallback))));

/**
 * Indexes for Rubato's own lookups that upstream does not define (RubatoQueryPlans.test.ts holds
 * the plans). The Rubato inventory asks every five seconds which thread shows each running
 * session, by a field inside a JSON column; without these it read both tables whole each time.
 * The tables hold one row per thread, so building them takes milliseconds.
 */
export const LOOKUP_INDEXES = [
  ["orchestration_v2_projection_provider_threads", `CREATE INDEX IF NOT EXISTS rubato_provider_threads_native_idx
    ON orchestration_v2_projection_provider_threads (driver, json_extract(payload_json, '$.nativeThreadRef.nativeId'))`],
  ["provider_session_runtime", `CREATE INDEX IF NOT EXISTS rubato_provider_session_runtime_session_idx
    ON provider_session_runtime (provider_name, json_extract(resume_cursor_json, '$.sessionId'))`],
] as const;

export const ensureLookupIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, statement] of LOOKUP_INDEXES) {
    const exists = yield* sql<{ readonly found: number }>`
      SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if ((exists[0]?.found ?? 0) > 0) yield* sql.unsafe(statement).raw;
  }
});

/**
 * Keeps the planner's table statistics current. Upstream runs `PRAGMA optimize` when the file
 * opens, which analyzes a table again only after its row count changed tenfold, so statistics
 * taken while an index was still empty stay: a live database listed the per-thread event index
 * (750k rows) as empty, and SQLite walked all of it for each "newest event" read. A sampled
 * ANALYZE reads a few hundred rows of each index and takes milliseconds.
 */
export const refreshStatistics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`PRAGMA analysis_limit = ${RETENTION.analysisRows}`).raw;
  yield* sql.unsafe("ANALYZE").raw;
});

/** One pass of every rule. A failing rule is logged and the others still run. */
export const runRetention = Effect.gen(function* () {
  const nowMs = yield* Clock.currentTimeMillis;
  const [elapsed, report] = yield* Effect.timed(Effect.gen(function* () {
    const compacted = yield* step("events", compactEvents(nowMs), { compactedEvents: 0, supersededTurnItems: 0 });
    const legacy = yield* step("legacy", pruneImportedLegacy(), { events: 0, receipts: 0 });
    const receipts = yield* step("receipts", pruneReceipts(nowMs), 0);
    const v1Rows = yield* step("v1-tables", pruneUnreadV1Tables, 0);
    const freedPages = yield* step("incremental-vacuum", releaseFreePages, 0);
    yield* step("statistics", refreshStatistics, undefined);
    return { ...compacted, legacyEvents: legacy.events, legacyReceipts: legacy.receipts,
      receipts, v1Rows, freedPages } satisfies RetentionReport;
  }));
  yield* Effect.logInfo("state retention pass", { ...report, durationMs: Duration.toMillis(elapsed) });
  return report;
});

/**
 * A pass after activation and the initial window's grace period, then every RETENTION.interval.
 * A fork alone is not enough: compaction uses synchronous SQLite on the same event loop as
 * startup. Park it at the server's existing activation boundary. Before the file is
 * incremental, the one-time VACUUM runs before the layer is ready, since it holds the connection.
 */
export const rubatoStateRetentionLayer = Layer.effectDiscard(Effect.gen(function* () {
  const mode = yield* autoVacuumMode.pipe(Effect.orElseSucceed(() => AUTO_VACUUM_INCREMENTAL));
  if (mode !== AUTO_VACUUM_INCREMENTAL) yield* step("compact", compactOnce, false);
  yield* step("indexes", ensureLookupIndexes, undefined);
  yield* step("statistics", refreshStatistics, undefined);
  const pass = step("pass", runRetention, undefined);
  yield* forkParked(Effect.sleep(RETENTION.startupDelay).pipe(
    Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(RETENTION.interval)))),
  ));
}));
