// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off -- fixtures are dated against the real clock
// The state DB retention (RubatoStateRetention.ts): what goes, that a thread replays to the same
// rows after it, that freed space reaches the disk, and that the server's layer runs it at
// startup and every interval.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId, MessageId, NodeId, ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId, TurnItemId,
  type OrchestrationV2AppThread, type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import {
  RETENTION, UNREAD_V1_TABLES, autoVacuumMode, compactOnce, pruneReceipts, pruneSupersededTurnItems,
  pruneUnreadV1Tables, releaseFreePages, rubatoStateRetentionLayer, runRetention,
} from "./RubatoStateRetention.ts";

const storesOver = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const stores = Layer.mergeAll(database, EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)));
  return Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)), IdAllocator.layer,
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)));
};
const layer = storesOver(SqlitePersistence.layerMemory);

const DAY = 24 * 60 * 60 * 1000;
const instanceId = ProviderInstanceId.make("rubato");
const threadOf = (id: ThreadId, at: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user", creationSource: "web", id, projectId: ProjectId.make(`project:${id}`), title: `Thread ${id}`,
  providerInstanceId: instanceId, modelSelection: { instanceId, model: "rubato/model" }, runtimeMode: "full-access",
  interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
  createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
});
let eventNumber = 0;
const itemUpdate = (threadId: ThreadId, item: string, text: string, at: DateTime.Utc, type: "assistant_message" | "command_execution" = "command_execution"): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:retention:${eventNumber++}`), type: "turn-item.updated", threadId, occurredAt: at,
  payload: type === "assistant_message"
    ? { id: TurnItemId.make(item), threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
        nativeItemRef: null, parentItemId: null, ordinal: 0, status: "completed", title: null, startedAt: at, completedAt: at,
        updatedAt: at, type, messageId: MessageId.make(`message:${item}`), text, streaming: false }
    : { id: TurnItemId.make(item), threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
        nativeItemRef: null, parentItemId: null, ordinal: 0, status: text === "done" ? "completed" : "running", title: null,
        startedAt: at, completedAt: text === "done" ? at : null, updatedAt: at, type, input: `echo ${item}`,
        output: text, ...(text === "done" ? { exitCode: 0 } : {}) },
});
const subagentUpdate = (threadId: ThreadId, prompt: string, progress: string, at: DateTime.Utc): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:retention:${eventNumber++}`), type: "turn-item.updated", threadId, occurredAt: at,
  payload: { id: TurnItemId.make("subagent-row"), threadId, runId: null, nodeId: null, providerThreadId: null,
    providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 0, status: "running", title: null,
    startedAt: at, completedAt: null, updatedAt: at, type: "subagent", subagentId: NodeId.make("subagent:retention"),
    origin: "provider_native", driver: ProviderDriverKind.make("rubato-pi"), providerInstanceId: instanceId,
    childThreadId: null, prompt, progress, result: null },
});
const itemRows = (threadId: ThreadId) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: string; readonly ordinal: number; readonly payload: string }>`
    SELECT turn_item_id AS id, ordinal, payload_json AS payload FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} ORDER BY ordinal`;
});

it.live("an item's older updates go once they are old; the thread rebuilds to the same rows, in order", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const nowMs = Date.now();
    const old = DateTime.makeUnsafe(nowMs - (RETENTION.eventDays + 1) * DAY);
    const recent = DateTime.makeUnsafe(nowMs - 60_000);
    const threadId = ThreadId.make("thread:retention-items");
    yield* sink.write({ events: [{ id: EventId.make("event:retention:create"), type: "thread.created", threadId,
      providerInstanceId: instanceId, occurredAt: old, payload: threadOf(threadId, old) }] });
    // Two tool rows written side by side, then each updated; a reply; a row still changing; a
    // row with more updates than one statement takes; a row updated once.
    for (const [item, text, at] of [["tool-a", "running", old], ["tool-b", "running", old], ["tool-a", "half", old],
      ["tool-b", "half", old], ["tool-a", "done", old], ["tool-b", "done", old], ["tool-c", "running", old],
      ["tool-c", "done", recent], ["tool-once", "done", old]] as const) yield* sink.write({ events: [itemUpdate(threadId, item, text, at)] });
    yield* sink.write({ events: [itemUpdate(threadId, "reply", "the answer", old, "assistant_message")] });
    // A subagent row: its prompt is stored once, four days ago; the later ticks point at it.
    const prompt = "Review the migration plan and report the risks.";
    yield* sink.write({ events: [subagentUpdate(threadId, prompt, "started", old)] });
    yield* sink.write({ events: [subagentUpdate(threadId, prompt, "reading", old)] });
    yield* sink.write({ events: [subagentUpdate(threadId, prompt, "writing the report", recent)] });
    const pointing = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM orchestration_events
      WHERE event_type = 'turn-item.updated' AND json_type(payload_json, '$.promptSequence') = 'integer'`;
    assert.isAbove(pointing[0]?.n ?? 0, 0, "the event store stores the subagent prompt once");
    for (let index = 0; index < RETENTION.chunk + 20; index += 1)
      yield* sink.write({ events: [itemUpdate(threadId, "tool-long", index === RETENTION.chunk + 19 ? "done" : `line ${index}`, old)] });
    const before = yield* itemRows(threadId);

    const deleted = yield* pruneSupersededTurnItems(nowMs);
    // tool-a and tool-b lose two each, tool-c its old update (a newer one exists), the subagent its
    // middle tick (the first holds the prompt the newest points at), tool-long all but its last.
    assert.strictEqual(deleted, 2 + 2 + 1 + 1 + (RETENTION.chunk + 19));
    const left = yield* sql<{ readonly item: string; readonly n: number }>`
      SELECT json_extract(payload_json, '$.id') AS item, COUNT(*) AS n FROM orchestration_events
      WHERE event_type = 'turn-item.updated' AND stream_id = ${threadId} GROUP BY item ORDER BY item`;
    assert.deepStrictEqual(left.map((row) => [row.item, row.n]),
      [["reply", 1], ["subagent-row", 2], ["tool-a", 1], ["tool-b", 1], ["tool-c", 1], ["tool-long", 1], ["tool-once", 1]]);
    assert.deepStrictEqual(yield* itemRows(threadId), before);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepStrictEqual(yield* itemRows(threadId), before);
    assert.deepStrictEqual(before.map((row) => row.id), ["tool-a", "tool-b", "tool-c", "tool-once", "reply", "subagent-row", "tool-long"]);
    const subagent = (yield* itemRows(threadId)).find((row) => row.id === "subagent-row");
    assert.strictEqual(JSON.parse(subagent!.payload).prompt, prompt);
    assert.strictEqual(yield* pruneSupersededTurnItems(nowMs), 0);
  }).pipe(Effect.provide(layer)));

it.live("a recent row that points at an old prompt keeps it, even when a newer row has another prompt", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const nowMs = Date.now();
    const old = DateTime.makeUnsafe(nowMs - (RETENTION.eventDays + 1) * DAY);
    const recent = DateTime.makeUnsafe(nowMs - 60_000);
    const threadId = ThreadId.make("thread:retention-prompts");
    yield* sink.write({ events: [{ id: EventId.make("event:retention:prompts-create"), type: "thread.created", threadId,
      providerInstanceId: instanceId, occurredAt: old, payload: threadOf(threadId, old) }] });
    yield* sink.write({ events: [subagentUpdate(threadId, "prompt A", "started", old)] });
    yield* sink.write({ events: [subagentUpdate(threadId, "prompt A", "still on A", recent)] });
    yield* sink.write({ events: [subagentUpdate(threadId, "prompt B", "moved on to B", recent)] });
    const stored = yield* sql<{ readonly points: number | null }>`
      SELECT json_extract(payload_json, '$.promptSequence') AS points FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type = 'turn-item.updated' ORDER BY sequence`;
    assert.deepStrictEqual(stored.map((row) => row.points !== null), [false, true, false]);

    assert.strictEqual(yield* pruneSupersededTurnItems(nowMs), 0);
    // Replaying every kept row, the middle one included, still finds its prompt.
    const replayed = yield* sql<{ readonly prompt: string | null }>`
      SELECT json_extract(payload_json, '$.prompt') AS prompt FROM orchestration_events AS event
      WHERE event.sequence = (SELECT json_extract(payload_json, '$.promptSequence') FROM orchestration_events
        WHERE stream_id = ${threadId} AND json_type(payload_json, '$.promptSequence') = 'integer')`;
    assert.strictEqual(replayed[0]?.prompt, "prompt A");
    assert.isTrue((yield* maintenance.rebuild).valid);
    const row = (yield* itemRows(threadId)).find((item) => item.id === "subagent-row");
    assert.strictEqual(JSON.parse(row!.payload).prompt, "prompt B");
  }).pipe(Effect.provide(layer)));

it.live("only old V2 receipts and the V1 tables nothing reads go; V1 messages and pending V1 receipts stay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowMs = Date.now();
    const oldIso = new Date(nowMs - (RETENTION.receiptDays + 1) * DAY).toISOString();
    const recentIso = new Date(nowMs - 60_000).toISOString();
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type) VALUES
      ('old-v2', 'thread', 't', ${oldIso}, 1, 'accepted', 'message.dispatch'),
      ('recent-v2', 'thread', 't', ${recentIso}, 1, 'accepted', 'message.dispatch'),
      ('old-legacy', 'thread', 't', ${oldIso}, 1, 'accepted', 'legacy')`;
    for (let index = 0; index < RETENTION.chunk + 5; index += 1)
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES (${`activity-${index}`}, 't', NULL, 'info', 'tool.completed', 's', '{}', ${oldIso})`;
    yield* sql`INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at) VALUES ('t', 0, 1, 'diff', ${oldIso})`;
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('v1-message', 't', NULL, 'user', 'kept for the lazy V1 import', 0, ${oldIso}, ${oldIso})`;

    assert.strictEqual(yield* pruneReceipts(nowMs), 1);
    assert.strictEqual(yield* pruneUnreadV1Tables, RETENTION.chunk + 6);
    const receipts = yield* sql<{ readonly id: string }>`SELECT command_id AS id FROM orchestration_command_receipts ORDER BY id`;
    assert.deepStrictEqual(receipts.map((row) => row.id), ["old-legacy", "recent-v2"]);
    for (const table of UNREAD_V1_TABLES) {
      const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
      assert.strictEqual(rows[0]?.n, 0);
    }
    const messages = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM projection_thread_messages`;
    assert.strictEqual(messages[0]?.n, 1);
    assert.strictEqual(yield* pruneReceipts(nowMs), 0);
  }).pipe(Effect.provide(layer)));

it.live("a file switched to incremental auto-vacuum once gives freed pages back to the disk", () => {
  const folder = mkdtempSync(join(tmpdir(), "rubato-retention-"));
  const file = join(folder, "statev2.sqlite");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const body = "x".repeat(8_000);
    yield* sql.withTransaction(Effect.gen(function* () {
      for (let index = 0; index < 3_000; index += 1)
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${`activity-${index}`}, 't', NULL, 'info', 'tool.completed', 's', ${body}, '2026-01-01T00:00:00.000Z')`;
    }));
    assert.notStrictEqual(yield* autoVacuumMode, 2);
    assert.isTrue(yield* compactOnce);
    assert.strictEqual(yield* autoVacuumMode, 2);
    assert.isFalse(yield* compactOnce);
    // The database's own size, which the file shrinks to at the next checkpoint.
    const pages = () => sql<{ readonly page_count: number }>`PRAGMA page_count`.pipe(
      Effect.map((rows) => Number(rows[0]?.page_count ?? 0)));
    const full = yield* pages();
    yield* pruneUnreadV1Tables;
    assert.isAbove(yield* releaseFreePages, 5_000);
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    assert.strictEqual(Number(free[0]?.freelist_count), 0);
    assert.isBelow(yield* pages(), full / 4);
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)").raw;
    assert.isAtMost(statSync(file).size, full * 4096);
  }).pipe(Effect.provide(storesOver(SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer)))),
    Effect.ensuring(Effect.sync(() => rmSync(folder, { recursive: true, force: true }))));
});

it.effect("the server's layer runs a pass at startup and again every interval", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const receipt = (id: string) => sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      VALUES (${id}, 'thread', 't', '2020-01-01T00:00:00.000Z', 1, 'accepted', 'message.dispatch')`;
    const left = () => sql<{ readonly id: string }>`SELECT command_id AS id FROM orchestration_command_receipts ORDER BY id`;
    yield* TestClock.setTime(Date.now());
    yield* receipt("before-start");
    yield* Layer.build(rubatoStateRetentionLayer);
    for (let turn = 0; turn < 50 && (yield* left()).length > 0; turn += 1) yield* TestClock.adjust(Duration.millis(10));
    assert.deepStrictEqual(yield* left(), []);
    yield* receipt("after-first-pass");
    yield* TestClock.adjust(Duration.hours(1));
    assert.deepStrictEqual((yield* left()).map((row) => row.id), ["after-first-pass"]);
    yield* TestClock.adjust(RETENTION.interval);
    for (let turn = 0; turn < 50 && (yield* left()).length > 0; turn += 1) yield* TestClock.adjust(Duration.millis(10));
    assert.deepStrictEqual(yield* left(), []);
    // A pass reports what it did, and a second pass right after finds nothing more.
    const report = yield* runRetention.pipe(Effect.provide(Layer.fresh(ProjectionMaintenance.layer.pipe(
      Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer))))));
    assert.deepStrictEqual({ ...report, freedPages: 0 }, { compactedEvents: 0, compactedReceipts: 0, supersededTurnItems: 0,
      receipts: 0, v1Rows: 0, freedPages: 0 });
  }).pipe(Effect.scoped, Effect.provide(layer)));
