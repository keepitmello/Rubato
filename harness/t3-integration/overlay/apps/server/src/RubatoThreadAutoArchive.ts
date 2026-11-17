/**
 * Archives threads nobody has touched for AUTO_ARCHIVE.idleDays, on T3's V2 orchestrator
 * (thread-auto-archive-edits.mjs). Upstream archives only when the person asks, and Rubato shows
 * every session started elsewhere (the CLI, the scheduler) as a thread (RubatoPiInventory.ts), so
 * the active list only grew: 1,495 active threads on 2026-11-17, 154 of them used that week. Every
 * client loads the whole active list on each new connection (the phone on every return to the
 * app), and the server builds each row with a dozen per-thread lookups.
 *
 * A thread's last activity is the newest of its own update time, its newest message and its
 * newest run; the thread row's update time alone misses new messages. A pass leaves alone:
 * - a pinned thread, a child thread (it follows its parent), a side chat (RubatoSideChat.ts);
 * - a thread with a run that is queued, starting, running or waiting;
 * - a companion's room (its sessions are marked in the engine's session list): the room cannot
 *   open an archived thread and would take it out again (RubatoCompanion.ts companionRoom).
 * A pass that cannot ask a Rubato engine which sessions are companions archives nothing.
 *
 * Every archive this file makes is recorded with the archive time it got. When the engine runs
 * that thread's session again (the person resumed it in a terminal), the inventory takes the
 * thread out of the archive (reopenAutoArchived), as it would have shown a thread it never saw.
 * An archive the person made, or one made again after they took the thread out, is theirs.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { rubatoBridgeFor } from "./provider/Drivers/RubatoPiDriver.ts";
import { threadOfPiSession } from "./provider/RubatoPiSessions.ts";

export const AUTO_ARCHIVE = {
  idleDays: 14,
  interval: Duration.hours(1),
  /** Let the first window load and the inventory catch up before the first pass. */
  startupDelay: Duration.minutes(2),
  /**
   * The least a pass rests between two archives; it also rests as long as each one took. Each
   * archive sends the relay one publish (AgentAwarenessRelay, ~0.4s each), so a first pass over a
   * thousand idle threads spreads over minutes instead of queueing them all at once.
   */
  pause: Duration.millis(250),
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;

const ensureTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS rubato_auto_archived (thread_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL)`;
});

/** Active threads idle since before `nowMs - idleDays`, oldest activity first; only `only` when given. */
export const autoArchiveCandidates = (nowMs: number, only?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(nowMs - AUTO_ARCHIVE.idleDays * DAY_MS));
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.updated_at < ${cutoff}
        AND t.thread_id NOT LIKE 'side-chat:%'${only === undefined ? sql`` : sql` AND t.thread_id = ${only}`}
        AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
        AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND (r.status IN ${sql.in(BUSY_STATUSES)} OR r.requested_at >= ${cutoff} OR r.completed_at >= ${cutoff}))
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages m
          WHERE m.thread_id = t.thread_id AND m.created_at >= ${cutoff})
      ORDER BY t.updated_at ASC, t.thread_id ASC`;
    return rows.map((row) => ThreadId.make(row.thread_id));
  });

export interface AutoArchiveIo<E, A, R> {
  /** Threads a pass must leave alone this time; none means the pass archives nothing. */
  readonly keep: Effect.Effect<Option.Option<ReadonlySet<string>>, E, R>;
  readonly archive: (threadId: ThreadId) => Effect.Effect<void, A, R>;
}

/** One pass: archives every candidate outside `keep`, one at a time, and records each. */
export const runAutoArchivePass = <E, A, R>(io: AutoArchiveIo<E, A, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureTable;
    const keep = yield* io.keep;
    if (Option.isNone(keep)) {
      yield* Effect.logInfo("thread auto-archive skipped: companion sessions unknown");
      return 0;
    }
    const candidates = (yield* autoArchiveCandidates(yield* Clock.currentTimeMillis))
      .filter((threadId) => !keep.value.has(threadId));
    let archived = 0;
    for (const threadId of candidates) {
      // A pass takes minutes: a thread used since the list was read stays.
      const stillIdle = (yield* autoArchiveCandidates(yield* Clock.currentTimeMillis, threadId)).length > 0;
      if (!stillIdle) continue;
      const [elapsed, done] = yield* Effect.timed(io.archive(threadId).pipe(
        Effect.andThen(sql<{ readonly archived_at: string | null }>`
          SELECT archived_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`),
        Effect.flatMap((rows) => {
          const at = rows[0]?.archived_at ?? null;
          return at === null ? Effect.succeed(false) : sql`
            INSERT INTO rubato_auto_archived (thread_id, archived_at) VALUES (${threadId}, ${at})
            ON CONFLICT (thread_id) DO UPDATE SET archived_at = excluded.archived_at`.pipe(Effect.as(true));
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("thread auto-archive failed", { threadId, cause }).pipe(Effect.as(false))),
      ));
      if (done) archived += 1;
      yield* Effect.sleep(Duration.max(elapsed, AUTO_ARCHIVE.pause));
    }
    if (candidates.length > 0) yield* Effect.logInfo("thread auto-archive pass", { candidates: candidates.length, archived });
    return archived;
  });

/**
 * Takes a thread this file archived out of the archive, when that archive still stands. True
 * when the thread is active afterwards; false for an archive the person made.
 */
export const reopenAutoArchived = <E, R>(threadId: string, unarchive: (threadId: ThreadId) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureTable;
    const rows = yield* sql<{ readonly recorded: string; readonly current: string | null; readonly deleted: string | null }>`
      SELECT a.archived_at AS recorded, t.archived_at AS current, t.deleted_at AS deleted
      FROM rubato_auto_archived a JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
      WHERE a.thread_id = ${threadId}`;
    const row = rows[0];
    if (row === undefined) return false;
    yield* sql`DELETE FROM rubato_auto_archived WHERE thread_id = ${threadId}`;
    if (row.deleted !== null || row.current === null || row.current !== row.recorded) return false;
    yield* unarchive(ThreadId.make(threadId));
    return true;
  });

/** Threads that are companions' rooms, from every enabled Rubato engine; none when one cannot answer. */
const companionThreads = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const threads = new Set<string>();
  if (Option.isNone(registry)) return Option.some<ReadonlySet<string>>(threads);
  for (const instance of yield* registry.value.listInstances) {
    const bridge = rubatoBridgeFor(instance);
    if (!bridge || !instance.enabled) continue;
    const sessions = yield* Effect.tryPromise(() => bridge.inventory()).pipe(Effect.option);
    if (Option.isNone(sessions)) return Option.none<ReadonlySet<string>>();
    for (const entry of sessions.value) {
      if (entry.companion !== true) continue;
      const threadId = yield* threadOfPiSession(entry.sessionId);
      if (threadId !== null) threads.add(threadId);
    }
  }
  return Option.some<ReadonlySet<string>>(threads);
});

export const makeRubatoThreadAutoArchive = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  if (Option.isNone(sql) || Option.isNone(orchestrator)) return { start: Effect.void };
  const archive = (threadId: ThreadId) => Effect.gen(function* () {
    const commandId = CommandId.make(`rubato-auto-archive:${threadId}:${yield* Clock.currentTimeMillis}`);
    yield* orchestrator.value.dispatch({ type: "thread.archive", commandId, threadId });
  });
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const keep = Option.match(registry, {
    onNone: () => companionThreads,
    onSome: (value) => companionThreads.pipe(Effect.provideService(ProviderInstanceRegistry, value)),
  });
  const pass = runAutoArchivePass({ keep, archive }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql.value),
    Effect.catchCause((cause) => Effect.logWarning("thread auto-archive pass failed", { cause })),
  );
  return {
    // The caller runs this only after the command runtime is active.
    start: Effect.forkScoped(Effect.sleep(AUTO_ARCHIVE.startupDelay).pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(AUTO_ARCHIVE.interval)))),
    )).pipe(Effect.asVoid),
  };
});
