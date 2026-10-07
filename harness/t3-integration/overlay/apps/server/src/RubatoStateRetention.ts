import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ORCHESTRATION_PROJECTOR_NAMES } from "./orchestration/Layers/ProjectionPipeline.ts";
import { layerConfig as sqlitePersistenceLayer } from "./persistence/Layers/Sqlite.ts";

// Rubato: the state DB had no retention and grew ~150MB a day. This job removes
// what no screen shows any more and gives the space back to the disk.
//
// What goes, and why nobody sees it go:
// - `thread.activity-appended` events older than 3 days that every projector has
//   applied. Thread views read the projection tables; a projector bootstraps from
//   its own cursor, so an applied event is never read again. Resume replay
//   already tolerates gaps in the global sequence.
// - command receipts older than 3 days. They only answer "was this command id
//   handled already", which matters for retries seconds apart.
// - work-log rows of threads deleted more than 3 days ago.
// - on work-log rows older than 14 days:
//   - the tool output body (`data.content`). The server cuts every activity
//     payload down to a fixed set of fields before a client sees it
//     (ActivityPayloadProjection.ts), and `data.content` only reaches a client
//     through entries of type "content", which are kept;
//   - `tool.updated` rows that a later `tool.completed` of the same call in the
//     same turn replaces. Thread snapshots already drop exactly these;
//   - `context-window.updated` rows except the newest two per turn. Snapshots
//     keep the newest one per turn; compaction reads the newest two.
//
// Every step runs in small statements with pauses between them, because the
// server has one SQLite connection and node:sqlite blocks the event loop while a
// statement runs.

export const RETENTION = {
  eventDays: 3,
  receiptDays: 3,
  deletedThreadDays: 3,
  workLogDays: 14,
  interval: Duration.hours(6),
  /** Rows (or rowids) one statement may touch. */
  chunk: 500,
  /** Free pages one incremental_vacuum statement returns to the disk. */
  vacuumPages: 2000,
  pause: Duration.millis(5),
} as const;

// The cleanup cursor is not one of the named projectors; ProjectionPipeline.ts
// keeps it beside them under this literal.
export const ATTACHMENT_CLEANUP_PROJECTOR = "projection.attachment-cleanup";
const PROJECTORS = [...Object.values(ORCHESTRATION_PROJECTOR_NAMES), ATTACHMENT_CLEANUP_PROJECTOR];

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_VACUUM_INCREMENTAL = 2;
const TOOL_KINDS = ["tool.started", "tool.updated", "tool.completed"];

export interface RetentionReport {
  activityEvents: number;
  receipts: number;
  deletedThreadActivities: number;
  trimmedOutputs: number;
  supersededToolUpdates: number;
  contextWindowRows: number;
  freedPages: number;
}

function changesOf(result: unknown): number {
  if (result === null || typeof result !== "object" || !("changes" in result)) return 0;
  const changes = Number(result.changes);
  return Number.isFinite(changes) ? changes : 0;
}

const isoBefore = (nowMs: number, days: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - days * DAY_MS));

/**
 * Highest event sequence every projector has applied, or 0 when any projector
 * has no cursor yet (a new projector replays from 0 and needs every event).
 */
const appliedBound = Effect.fn("RubatoStateRetention.appliedBound")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly known: number; readonly bound: number | null }>`
    SELECT
      (SELECT COUNT(*) FROM projection_state WHERE ${sql.in("projector", PROJECTORS)}) AS "known",
      (SELECT MIN(last_applied_sequence) FROM projection_state) AS "bound"
  `;
  const row = rows[0];
  return row && row.known === PROJECTORS.length && row.bound !== null ? row.bound : 0;
});

/** Walks a table by rowid ranges up to `last`, one statement per range. */
const forRanges = (last: number, step: (from: number, to: number) => Effect.Effect<number, SqlError>) =>
  Effect.gen(function* () {
    let total = 0;
    for (let from = 0; from < last; from += RETENTION.chunk) {
      total += yield* step(from, Math.min(from + RETENTION.chunk, last));
      yield* Effect.sleep(RETENTION.pause);
    }
    return total;
  });

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

const maxRowid = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly last: number | null }>`
      SELECT MAX(rowid) AS "last" FROM ${sql(table)}
    `;
    return rows[0]?.last ?? 0;
  });

export const pruneActivityEvents = Effect.fn("RubatoStateRetention.pruneActivityEvents")(function* (
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.eventDays);
  const bound = yield* appliedBound();
  // The bound is read again inside each statement: a projector reset between
  // two chunks must stop the deletion, not race it.
  return yield* forRanges(bound, (from, to) =>
    sql`
      DELETE FROM orchestration_events
      WHERE sequence > ${from}
        AND sequence <= ${to}
        AND event_type = 'thread.activity-appended'
        AND occurred_at < ${cutoff}
        AND sequence <= (
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM projection_state WHERE ${sql.in("projector", PROJECTORS)}) = ${PROJECTORS.length}
            THEN (SELECT MIN(last_applied_sequence) FROM projection_state)
            ELSE 0
          END
        )
    `.raw.pipe(Effect.map(changesOf)),
  );
});

export const pruneReceipts = Effect.fn("RubatoStateRetention.pruneReceipts")(function* (
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.receiptDays);
  return yield* forRanges(yield* maxRowid("orchestration_command_receipts"), (from, to) =>
    sql`
      DELETE FROM orchestration_command_receipts
      WHERE rowid > ${from} AND rowid <= ${to} AND accepted_at < ${cutoff}
    `.raw.pipe(Effect.map(changesOf)),
  );
});

export const pruneDeletedThreadActivities = Effect.fn(
  "RubatoStateRetention.pruneDeletedThreadActivities",
)(function* (nowMs: number) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.deletedThreadDays);
  return yield* untilShort(
    sql`
      DELETE FROM projection_thread_activities
      WHERE rowid IN (
        SELECT activity.rowid
        FROM projection_threads AS thread
        JOIN projection_thread_activities AS activity ON activity.thread_id = thread.thread_id
        WHERE thread.deleted_at IS NOT NULL AND thread.deleted_at < ${cutoff}
        LIMIT ${RETENTION.chunk}
      )
    `.raw.pipe(Effect.map(changesOf)),
  );
});

export const trimOldToolOutputs = Effect.fn("RubatoStateRetention.trimOldToolOutputs")(function* (
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = isoBefore(nowMs, RETENTION.workLogDays);
  return yield* forRanges(yield* maxRowid("projection_thread_activities"), (from, to) =>
    sql`
      UPDATE projection_thread_activities
      SET payload_json = json_remove(payload_json, '$.data.content')
      WHERE rowid > ${from}
        AND rowid <= ${to}
        AND created_at < ${cutoff}
        AND ${sql.in("kind", TOOL_KINDS)}
        AND json_valid(payload_json)
        AND json_type(payload_json, '$.data.content') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.data.content') AS entry
          WHERE CASE WHEN entry.type = 'object' THEN json_extract(entry.value, '$.type') END = 'content'
        )
    `.raw.pipe(Effect.map(changesOf)),
  );
});

// Mirrors toolLifecycleIdentity in ActivityPayloadProjection.ts for rows that
// carry a call id. Rows without one are left alone.
const toolCallIdOf = (alias: string) => `COALESCE(
  NULLIF(TRIM(json_extract(${alias}.payload_json, '$.toolCallId')), ''),
  NULLIF(TRIM(json_extract(${alias}.payload_json, '$.data.toolCallId')), '')
)`;

const pruneThreadIntermediates = (threadId: string, cutoff: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const toolUpdates = yield* untilShort(
      sql`
        WITH completions AS MATERIALIZED (
          SELECT
            turn_id,
            ${sql.literal(toolCallIdOf("completion"))} AS tool_call_id,
            COALESCE(sequence, -1) AS seq,
            created_at,
            activity_id
          FROM projection_thread_activities AS completion
          WHERE thread_id = ${threadId} AND kind = 'tool.completed' AND json_valid(payload_json)
        )
        DELETE FROM projection_thread_activities
        WHERE rowid IN (
          SELECT updated.rowid
          FROM projection_thread_activities AS updated
          WHERE updated.thread_id = ${threadId}
            AND updated.created_at < ${cutoff}
            AND updated.kind = 'tool.updated'
            AND json_valid(updated.payload_json)
            AND EXISTS (
              SELECT 1 FROM completions AS completion
              WHERE completion.tool_call_id = ${sql.literal(toolCallIdOf("updated"))}
                AND completion.turn_id IS updated.turn_id
                AND (completion.seq, completion.created_at, completion.activity_id)
                  > (COALESCE(updated.sequence, -1), updated.created_at, updated.activity_id)
            )
          LIMIT ${RETENTION.chunk}
        )
      `.raw.pipe(Effect.map(changesOf)),
    );
    yield* Effect.sleep(RETENTION.pause);
    const contextWindowRows = yield* untilShort(
      sql`
        DELETE FROM projection_thread_activities
        WHERE rowid IN (
          SELECT row_id FROM (
            SELECT
              rowid AS row_id,
              created_at,
              ROW_NUMBER() OVER (
                PARTITION BY turn_id
                ORDER BY COALESCE(sequence, -1) DESC, created_at DESC, activity_id DESC
              ) AS newest
            FROM projection_thread_activities
            WHERE thread_id = ${threadId}
              AND kind = 'context-window.updated'
              AND json_valid(payload_json)
              AND json_type(payload_json, '$.usedTokens') IN ('integer', 'real')
              AND json_extract(payload_json, '$.usedTokens') >= 0
          )
          WHERE newest > 2 AND created_at < ${cutoff}
          LIMIT ${RETENTION.chunk}
        )
      `.raw.pipe(Effect.map(changesOf)),
    );
    return { toolUpdates, contextWindowRows };
  });

export const pruneOldIntermediates = Effect.fn("RubatoStateRetention.pruneOldIntermediates")(
  function* (nowMs: number) {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = isoBefore(nowMs, RETENTION.workLogDays);
    const threads = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads WHERE deleted_at IS NULL
    `;
    let supersededToolUpdates = 0;
    let contextWindowRows = 0;
    for (const { threadId } of threads) {
      const pruned = yield* pruneThreadIntermediates(threadId, cutoff);
      supersededToolUpdates += pruned.toolUpdates;
      contextWindowRows += pruned.contextWindowRows;
      yield* Effect.sleep(RETENTION.pause);
    }
    return { supersededToolUpdates, contextWindowRows };
  },
);

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
    // node:sqlite runs a statement without result columns for one step only, and
    // one step of incremental_vacuum frees one page. So: one statement per page,
    // all in one transaction so they share a single commit.
    const pages = Math.min(free, RETENTION.vacuumPages);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let page = 0; page < pages; page += 1)
          yield* sql.unsafe("PRAGMA incremental_vacuum(1)").raw;
      }),
    );
    const after = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const left = Number(after[0]?.freelist_count ?? 0);
    if (left >= free) return freed;
    freed += free - left;
    yield* Effect.sleep(RETENTION.pause);
  }
});

const step = <A>(name: string, effect: Effect.Effect<A, SqlError, SqlClient.SqlClient>, fallback: A) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("state retention step failed", { step: name, cause }).pipe(Effect.as(fallback)),
    ),
  );

/** One pass of every rule. A failing rule is logged and the others still run. */
export const runRetention = Effect.gen(function* () {
  const nowMs = yield* Clock.currentTimeMillis;
  const [elapsed, report] = yield* Effect.timed(
    Effect.gen(function* () {
      const activityEvents = yield* step("activity-events", pruneActivityEvents(nowMs), 0);
      const receipts = yield* step("receipts", pruneReceipts(nowMs), 0);
      const deletedThreadActivities = yield* step(
        "deleted-thread-activities",
        pruneDeletedThreadActivities(nowMs),
        0,
      );
      const trimmedOutputs = yield* step("tool-outputs", trimOldToolOutputs(nowMs), 0);
      const intermediates = yield* step("intermediates", pruneOldIntermediates(nowMs), {
        supersededToolUpdates: 0,
        contextWindowRows: 0,
      });
      const freedPages = yield* step("incremental-vacuum", releaseFreePages, 0);
      return {
        activityEvents,
        receipts,
        deletedThreadActivities,
        trimmedOutputs,
        ...intermediates,
        freedPages,
      } satisfies RetentionReport;
    }),
  );
  yield* Effect.logInfo("state retention pass finished", {
    ...report,
    durationMs: Duration.toMillis(elapsed),
  });
  return report;
});

/**
 * Switches the file to incremental auto-vacuum. That takes one full VACUUM,
 * which rewrites the file and cannot run inside a transaction; afterwards each
 * pass hands its freed pages back with incremental_vacuum instead.
 */
export const compactOnce = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* autoVacuumMode) === AUTO_VACUUM_INCREMENTAL) return false;
  const [elapsed] = yield* Effect.timed(
    Effect.gen(function* () {
      yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL").raw;
      yield* sql.unsafe("VACUUM").raw;
      // VACUUM goes through the WAL; give that space back now too.
      yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)").raw;
    }),
  );
  yield* Effect.logInfo("state database compacted", { durationMs: Duration.toMillis(elapsed) });
  return true;
});

/**
 * Runs a pass at startup and every RETENTION.interval after it. Before the file
 * is incremental, the first pass and the one-time VACUUM run before the layer is
 * ready, so the server serves nothing while they hold the connection; later
 * startups run the pass in the background.
 */
export const rubatoStateRetentionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const periodic = runRetention.pipe(Effect.repeat(Schedule.spaced(RETENTION.interval)));
    const mode = yield* autoVacuumMode.pipe(Effect.orElseSucceed(() => AUTO_VACUUM_INCREMENTAL));
    if (mode === AUTO_VACUUM_INCREMENTAL) {
      yield* Effect.forkScoped(periodic);
      return;
    }
    yield* runRetention;
    yield* step("compact", compactOnce, false);
    yield* Effect.forkScoped(Effect.sleep(RETENTION.interval).pipe(Effect.andThen(periodic)));
  }),
);

export const rubatoStatePersistenceLayer = rubatoStateRetentionLayer.pipe(
  Layer.provideMerge(sqlitePersistenceLayer),
);
