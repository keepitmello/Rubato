/**
 * Keeps the GUI server's state database bounded on T3's V2 orchestrator (state-retention-edits.mjs).
 * Upstream keeps every event and command receipt and never calls its own compaction, and
 * statev2.sqlite starts as a full copy of the V1 database (initializeV2Database.ts). The V1 file
 * grew ~150MB a day before Rubato pruned it.
 *
 * What goes, and why nothing shown or replayed needs it:
 * - Upstream's own compaction (ProjectionMaintenanceV2.compactEventStore): thread-state events a
 *   newer one of the same thread supersedes, older versions of a message or node, and the V1
 *   events and receipts of threads whose V1 transcript V2 has already imported. Built for
 *   replay: verify and rebuild read what it keeps.
 * - `turn-item.updated` events older than RETENTION.eventDays that a newer update of the same
 *   item supersedes. The projection replaces an item's whole row on every update (upsertById,
 *   ProjectionStore apply) and every update carries the item's ordinal, so the newest update
 *   alone rebuilds the same row at the same position. A subagent row stores its prompt once and
 *   later rows point at it (`promptSequence`, OrchestrationEventStore appendAgentEvents), so a
 *   row any kept row points at stays. Upstream leaves these events alone; they are most of what a
 *   long tool-heavy conversation writes.
 * - V2 command receipts older than RETENTION.receiptDays. A receipt answers "was this command
 *   handled already" for a retry seconds or minutes later; nothing replays from it. V1 receipts
 *   are upstream's to remove (only once their thread is imported).
 * - Rows of the copied V1 tables nothing on V2 reads (UNREAD_V1_TABLES). The lazy V1 import
 *   reads V1 threads, messages and pull requests; the V1 work log, turns and diff blobs are
 *   never read again. The V1 state.sqlite beside this file keeps its own copy.
 *
 * Freed pages go back to the disk: the file is switched to incremental auto-vacuum once (one
 * VACUUM, before the server serves), and every pass hands its free pages back. Every step runs
 * in small statements with pauses, because the server has one SQLite connection and node:sqlite
 * blocks the event loop while a statement runs. A step that fails is logged and the others and
 * later passes still run.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { forkParked } from "./serverActivation.ts";

export const RETENTION = {
  eventDays: 3,
  receiptDays: 3,
  interval: Duration.hours(6),
  /** Let the initial window and its history load before competing for the writer connection. */
  startupDelay: Duration.seconds(30),
  /** Rows one statement may touch. */
  chunk: 500,
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
  readonly compactedReceipts: number;
  readonly supersededTurnItems: number;
  readonly receipts: number;
  readonly v1Rows: number;
  readonly freedPages: number;
}

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

/**
 * Walks the turn-item updates newest first and deletes an old one once a newer update of the
 * same item was seen. Pages by sequence, so every page is reached however sparse the matches.
 */
export const pruneSupersededTurnItems = Effect.fn("RubatoStateRetention.pruneSupersededTurnItems")(function* (
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.eventDays);
  const top = yield* sql<{ readonly last: number | null }>`SELECT MAX(sequence) AS last FROM orchestration_events`;
  let through = top[0]?.last ?? 0;
  const seen = new Set<string>();
  const anchors = new Set<number>();
  let deleted = 0;
  while (through > 0) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly stream_id: string;
      readonly item_id: string | null;
      readonly occurred_at: string;
      readonly prompt_sequence: number | null;
    }>`
      SELECT sequence, stream_id, json_extract(payload_json, '$.id') AS item_id, occurred_at,
        CASE WHEN json_type(payload_json, '$.promptSequence') = 'integer'
          THEN json_extract(payload_json, '$.promptSequence') END AS prompt_sequence
      FROM orchestration_events
      WHERE sequence <= ${through} AND application_event_version = 2 AND event_type = 'turn-item.updated'
      ORDER BY sequence DESC
      LIMIT ${RETENTION.chunk}
    `;
    const obsolete: Array<number> = [];
    for (const row of rows) {
      if (row.item_id === null) continue;
      const key = `${row.stream_id}\u0000${row.item_id}`;
      // The newest row of an item stays, so do recent rows and rows a kept row points at; the
      // prompt any kept row points at stays with it.
      const kept = !seen.has(key) || row.occurred_at >= cutoff || anchors.has(row.sequence);
      seen.add(key);
      if (!kept) obsolete.push(row.sequence);
      else if (row.prompt_sequence !== null) anchors.add(Number(row.prompt_sequence));
    }
    if (obsolete.length > 0) {
      deleted += changesOf(yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`.raw);
    }
    yield* Effect.sleep(RETENTION.pause);
    if (rows.length < RETENTION.chunk) break;
    through = rows.at(-1)!.sequence - 1;
  }
  return deleted;
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

/** One pass of every rule. A failing rule is logged and the others still run. */
export const runRetention = Effect.gen(function* () {
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const nowMs = yield* Clock.currentTimeMillis;
  const [elapsed, report] = yield* Effect.timed(Effect.gen(function* () {
    const compacted = yield* step("compact-event-store", maintenance.compactEventStore,
      { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 });
    const supersededTurnItems = yield* step("turn-items", pruneSupersededTurnItems(nowMs), 0);
    const receipts = yield* step("receipts", pruneReceipts(nowMs), 0);
    const v1Rows = yield* step("v1-tables", pruneUnreadV1Tables, 0);
    const freedPages = yield* step("incremental-vacuum", releaseFreePages, 0);
    return { compactedEvents: compacted.deletedEventCount, compactedReceipts: compacted.deletedReceiptCount,
      supersededTurnItems, receipts, v1Rows, freedPages } satisfies RetentionReport;
  }));
  yield* Effect.logInfo("state retention pass", { ...report, durationMs: Duration.toMillis(elapsed) });
  return report;
});

/** Upstream's maintenance service over the same connection (runtimeLayer.ts builds the same). */
export const retentionMaintenanceLayer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
);

/**
 * A pass after activation and the initial window's grace period, then every RETENTION.interval.
 * A fork alone is not enough: compaction uses synchronous SQLite on the same event loop as
 * startup. Park it at the server's existing activation boundary. Before the file is
 * incremental, the one-time VACUUM runs before the layer is ready, since it holds the connection.
 */
export const rubatoStateRetentionLayer = Layer.effectDiscard(Effect.gen(function* () {
  const mode = yield* autoVacuumMode.pipe(Effect.orElseSucceed(() => AUTO_VACUUM_INCREMENTAL));
  if (mode !== AUTO_VACUUM_INCREMENTAL) yield* step("compact", compactOnce, false);
  const pass = step("pass", runRetention, undefined);
  yield* forkParked(Effect.sleep(RETENTION.startupDelay).pipe(
    Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(RETENTION.interval)))),
  ));
})).pipe(Layer.provide(retentionMaintenanceLayer));
