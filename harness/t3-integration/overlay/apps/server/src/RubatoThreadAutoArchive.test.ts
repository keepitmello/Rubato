// @effect-diagnostics globalDate:off globalDateInEffect:off -- fixtures are dated against the real clock
// Idle threads going to the archive on their own (RubatoThreadAutoArchive.ts): which threads a pass
// picks, that it leaves companions' rooms alone or does nothing when it cannot tell them, and
// that only its own archive is undone when a session runs again.
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { AUTO_ARCHIVE, autoArchiveCandidates, reopenAutoArchived, runAutoArchivePass } from "./RubatoThreadAutoArchive.ts";

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (days: number) => iso(Date.now() - days * DAY);
const idle = AUTO_ARCHIVE.idleDays + 1;

interface ThreadFixture {
  readonly id: string;
  readonly updatedDaysAgo: number;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly pinned?: boolean;
  readonly parent?: string;
}
const addThread = (thread: ThreadFixture) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = daysAgo(thread.updatedDaysAgo);
  const payload = JSON.stringify({ id: thread.id, title: thread.id, pinnedAt: thread.pinned ? at : null,
    lineage: { parentThreadId: thread.parent ?? null, relationshipToParent: thread.parent ? "subagent" : null, rootThreadId: thread.parent ?? thread.id } });
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${thread.id}, 'project', ${thread.id}, 'rubato-pi', 'full-access', 'default', ${at}, ${at},
      ${thread.archived ? at : null}, ${thread.deleted ? at : null}, ${payload})`;
});
let runOrdinal = 0;
const addRun = (threadId: string, status: string, requestedDaysAgo: number, completedDaysAgo: number | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    runOrdinal += 1;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES (${`run:${threadId}:${runOrdinal}`}, ${threadId}, ${runOrdinal}, 'rubato-pi', ${status}, ${daysAgo(requestedDaysAgo)},
        ${completedDaysAgo === null ? null : daysAgo(completedDaysAgo)}, '{}')`;
  });
const addMessage = (threadId: string, createdDaysAgo: number) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = daysAgo(createdDaysAgo);
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${`message:${threadId}:${at}`}, ${threadId}, 'user', 0, ${at}, ${at}, '{}')`;
});
const archivedAt = (threadId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly archived_at: string | null }>`
    SELECT archived_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
  return rows[0]?.archived_at ?? null;
});
/** What the orchestrator's archive leaves in the projection, with the time it got. */
const archiveRow = (threadId: ThreadId) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${iso(Date.now())} WHERE thread_id = ${threadId}`;
});
const unarchiveRow = (threadId: ThreadId) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}`;
});
class ArchiveRefused extends Data.TaggedError("ArchiveRefused")<{}> {}
const keepNone = Effect.succeedSome<ReadonlySet<string>>(new Set());

it.live("a pass picks only threads idle for the whole period, by their messages and runs too", () =>
  Effect.gen(function* () {
    for (const thread of [
      { id: "idle", updatedDaysAgo: idle },
      { id: "recent", updatedDaysAgo: 1 },
      { id: "recent-message", updatedDaysAgo: idle },
      { id: "recent-run", updatedDaysAgo: idle },
      { id: "recently-finished-run", updatedDaysAgo: idle },
      { id: "running", updatedDaysAgo: idle },
      { id: "queued", updatedDaysAgo: idle },
      { id: "old-run", updatedDaysAgo: idle },
      { id: "pinned", updatedDaysAgo: idle, pinned: true },
      { id: "child", updatedDaysAgo: idle, parent: "idle" },
      { id: "side-chat:tab", updatedDaysAgo: idle },
      { id: "archived", updatedDaysAgo: idle, archived: true },
      { id: "deleted", updatedDaysAgo: idle, deleted: true },
    ]) yield* addThread(thread);
    yield* addMessage("idle", idle + 3);
    yield* addMessage("recent-message", 2);
    yield* addRun("recent-run", "completed", 3, null);
    yield* addRun("recently-finished-run", "completed", idle + 5, 2);
    yield* addRun("running", "running", idle + 5, null);
    yield* addRun("queued", "queued", idle + 5, null);
    yield* addRun("old-run", "completed", idle + 5, idle + 4);

    const picked = yield* autoArchiveCandidates(Date.now());
    assert.deepStrictEqual([...picked].sort(), ["idle", "old-run"]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)));

it.live("a pass archives the picked threads outside the kept ones and records each archive", () =>
  Effect.gen(function* () {
    yield* addThread({ id: "idle", updatedDaysAgo: idle });
    yield* addThread({ id: "companion-room", updatedDaysAgo: idle });
    yield* addThread({ id: "failing", updatedDaysAgo: idle });
    const archive = (threadId: ThreadId): Effect.Effect<void, SqlError | ArchiveRefused, SqlClient.SqlClient> =>
      threadId === "failing" ? Effect.fail(new ArchiveRefused()) : archiveRow(threadId);

    const archived = yield* runAutoArchivePass({ keep: Effect.succeedSome<ReadonlySet<string>>(new Set(["companion-room"])), archive });

    assert.strictEqual(archived, 1);
    assert.notStrictEqual(yield* archivedAt("idle"), null);
    assert.strictEqual(yield* archivedAt("companion-room"), null);
    assert.strictEqual(yield* archivedAt("failing"), null);
    const sql = yield* SqlClient.SqlClient;
    const recorded = yield* sql<{ readonly thread_id: string; readonly archived_at: string }>`
      SELECT thread_id, archived_at FROM rubato_auto_archived`;
    assert.deepStrictEqual(recorded.map((row) => row.thread_id), ["idle"]);
    assert.strictEqual(recorded[0]?.archived_at, yield* archivedAt("idle"));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)));

it.live("a pass that cannot tell companions' rooms apart archives nothing", () =>
  Effect.gen(function* () {
    yield* addThread({ id: "idle", updatedDaysAgo: idle });
    const archived = yield* runAutoArchivePass({ keep: Effect.succeedNone, archive: archiveRow });
    assert.strictEqual(archived, 0);
    assert.strictEqual(yield* archivedAt("idle"), null);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)));

it.live("a thread used while a pass runs is left out of that pass", () =>
  Effect.gen(function* () {
    yield* addThread({ id: "older", updatedDaysAgo: idle + 2 });
    yield* addThread({ id: "newer", updatedDaysAgo: idle + 1 });
    // The person writes in "newer" while the pass archives "older".
    const archive = (threadId: ThreadId) =>
      archiveRow(threadId).pipe(Effect.andThen(threadId === "older" ? addMessage("newer", 0) : Effect.void));

    const archived = yield* runAutoArchivePass({ keep: keepNone, archive });

    assert.strictEqual(archived, 1);
    assert.notStrictEqual(yield* archivedAt("older"), null);
    assert.strictEqual(yield* archivedAt("newer"), null);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)));

it.live("a session running again takes out only the archive the pass made", () =>
  Effect.gen(function* () {
    yield* addThread({ id: "auto", updatedDaysAgo: idle });
    yield* addThread({ id: "rearchived", updatedDaysAgo: idle });
    yield* addThread({ id: "theirs", updatedDaysAgo: idle, archived: true });
    yield* runAutoArchivePass({ keep: keepNone, archive: archiveRow });
    // The person took this one out and archived it again themselves.
    yield* unarchiveRow(ThreadId.make("rearchived"));
    yield* Effect.sleep("5 millis");
    yield* archiveRow(ThreadId.make("rearchived"));

    assert.isTrue(yield* reopenAutoArchived("auto", unarchiveRow));
    assert.strictEqual(yield* archivedAt("auto"), null);
    assert.isFalse(yield* reopenAutoArchived("rearchived", unarchiveRow));
    assert.notStrictEqual(yield* archivedAt("rearchived"), null);
    assert.isFalse(yield* reopenAutoArchived("theirs", unarchiveRow));
    assert.notStrictEqual(yield* archivedAt("theirs"), null);
    // The record goes with the reopen: a later archive by the person stays theirs.
    yield* archiveRow(ThreadId.make("auto"));
    assert.isFalse(yield* reopenAutoArchived("auto", unarchiveRow));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)));
