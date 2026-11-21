// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off -- fixtures are dated against the real clock
// The GUI server has one SQLite writer and a few readers, so one statement that reads a large
// table whole holds one of them for seconds and every request behind it waits
// (state-query-edits.mjs). This runs the server's hot reads and the state retention against a
// database built by the real migrations, records every statement they send, and asks SQLite how
// it would run each one: a plan that walks a large table from end to end fails, whichever code
// sent it.
import { assert, it } from "@effect/vitest";
import {
  EventId, ProjectId, ProviderInstanceId, ThreadId, TurnItemId,
  type OrchestrationV2AppThread, type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { piSessionOfThread, threadMessages, threadOfPiSession, threadStreamGaps } from "./provider/RubatoPiSessions.ts";
import { RETENTION, compactEvents, ensureLookupIndexes, runRetention } from "./RubatoStateRetention.ts";

/**
 * Tables that grow with every turn: no statement may read one from end to end. Tables with a row
 * per thread (threads, provider threads) stay in the thousands and may be read whole.
 */
export const LARGE_TABLES = [
  "orchestration_events", "orchestration_v2_projection_turn_items", "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_messages", "rubato_retention_newest",
];
const NOT_A_NAME = new Set(["where", "on", "indexed", "not", "left", "inner", "cross", "join", "order", "group",
  "limit", "using", "set", "values", "select", "natural", "outer", "as"]);

/**
 * What each name in SQLite's plan may read: the tables and CTEs the statement binds to it (its
 * alias, if any). One alias can name several sources in different parts of a statement.
 */
export const tablesOf = (query: string) => {
  const names = new Map<string, Set<string>>();
  for (const match of query.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
    const table = match[1]!.toLowerCase();
    const alias = match[2]?.toLowerCase();
    const name = alias !== undefined && !NOT_A_NAME.has(alias) ? alias : table;
    names.set(name, (names.get(name) ?? new Set()).add(table));
  }
  return names;
};

/**
 * The plan steps that read a large table whole: a SCAN of it, bare or through an index, or a
 * SEARCH through an index with no condition on it, which is how SQLite shows MIN or MAX over an
 * index. That is one entry when the index starts with the column (`leadingColumn`), and the whole
 * index otherwise. A bare SEARCH of the table is the same seek on its primary key.
 *
 * Two reads look like that and are bounded. A partial index (`partial`) holds only the rows its
 * WHERE admits, such as one thread's failures (migration 099's usage-limit index). And when the
 * statement also gives the step's name to a CTE the plan materializes or runs as a co-routine,
 * SQLite shows a read of those rows the same way: v0.1.11's thread window reads one thread's
 * items into `work_segments` and walks it as `item`.
 */
export const fullReads = (query: string, details: ReadonlyArray<string>,
  leadingColumn: (index: string) => string | undefined = () => undefined,
  partial: (index: string) => boolean = () => false) => {
  const sources = tablesOf(query);
  const builtCtes = new Set(details.flatMap((detail) =>
    /^(?:MATERIALIZE|CO-ROUTINE) ([a-z_][a-z0-9_]*)$/i.exec(detail)?.[1]?.toLowerCase() ?? []));
  const extreme = /\b(?:MIN|MAX)\(\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\)/i.exec(query)?.[1]?.toLowerCase();
  return details.filter((detail) => {
    const step = /^(SCAN|SEARCH) ([a-z_][a-z0-9_]*)/i.exec(detail);
    if (step === null) return false;
    const name = step[2]!.toLowerCase();
    const bound = [...(sources.get(name) ?? [name])];
    if (!bound.some((source) => LARGE_TABLES.includes(source))) return false;
    if (bound.some((source) => builtCtes.has(source))) return false;
    const index = /USING (?:COVERING )?INDEX ([a-z_][a-z0-9_]*)/i.exec(detail)?.[1];
    if (index !== undefined && partial(index)) return false;
    if (step[1]!.toUpperCase() === "SCAN") return true;
    if (index === undefined || detail.includes("(")) return false;
    return extreme === undefined || leadingColumn(index)?.toLowerCase() !== extreme;
  });
};

const layer = (() => {
  const database = SqlitePersistence.layerMemory;
  const stores = Layer.mergeAll(database, EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)));
  return Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)), IdAllocator.layer);
})();

const DAY = 24 * 60 * 60 * 1000;
const instanceId = ProviderInstanceId.make("rubato");
const threadOf = (id: ThreadId, at: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user", creationSource: "web", id, projectId: ProjectId.make("project:plans"), title: `Thread ${id}`,
  providerInstanceId: instanceId, modelSelection: { instanceId, model: "rubato/model" }, runtimeMode: "full-access",
  interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
  createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
});
let eventNumber = 0;
const itemUpdate = (threadId: ThreadId, item: string, output: string, at: DateTime.Utc): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:plans:${eventNumber++}`), type: "turn-item.updated", threadId, occurredAt: at,
  payload: { id: TurnItemId.make(item), threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal: 0, status: "running", title: null, startedAt: at, completedAt: null,
    updatedAt: at, type: "command_execution", input: `echo ${item}`, output },
});

it.live("the server's hot reads and the state retention read no large table from end to end", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const nowMs = Date.now();
    const old = DateTime.makeUnsafe(nowMs - (RETENTION.eventDays + 1) * DAY);
    const recent = DateTime.makeUnsafe(nowMs - 60_000);
    const threads = ["a", "b", "c"].map((name) => ThreadId.make(`thread:plans-${name}`));
    for (const threadId of threads) {
      yield* sink.write({ events: [{ id: EventId.make(`event:plans:create:${threadId}`), type: "thread.created", threadId,
        providerInstanceId: instanceId, occurredAt: old, payload: threadOf(threadId, old) }] });
      for (let index = 0; index < 6; index += 1)
        yield* sink.write({ events: [itemUpdate(threadId, `tool-${index % 2}`, `line ${index}`, old)] });
    }
    yield* ensureLookupIndexes;
    // The first pass sets where the next one starts; the next ones are what runs every six hours.
    yield* compactEvents(nowMs);
    yield* sink.write({ events: [itemUpdate(threads[0]!, "tool-0", "later", recent)] });

    const recorded: Array<{ readonly query: string; readonly params: ReadonlyArray<unknown> }> = [];
    const record: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      recorded.push({ query, params });
      return Effect.succeed(statement);
    };
    const threadId = threads[0]!;
    // What the app and the server's sweeps read most; a read that fails on this small fixture
    // has still sent its statements.
    const run = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      Effect.ignore(read.pipe(Effect.provideService(Statement.CurrentTransformer, record)));
    yield* run(events.latestSequence());
    yield* run(events.latestSequence({ threadId }));
    yield* run(events.latestApplicationSequence);
    yield* run(projections.getShellSnapshot());
    yield* run(projections.getThreadShell(threadId));
    yield* run(projections.getThread(threadId));
    yield* run(projections.getThreadSnapshot(threadId));
    yield* run(projections.getThreadSnapshotWindow(threadId, { rowLimit: 200, userTurnLimit: 20 }));
    yield* run(projections.getThreadProjection(threadId));
    yield* run(projections.getRuntimeRecoveryProjection(threadId));
    yield* run(projections.getMessageCount(threadId));
    yield* run(projections.getNextTurnItemOrdinal(threadId));
    yield* run(projections.getTurnStartHistory(threadId));
    yield* run(projections.getLimitRecoveryCandidates({ now: DateTime.makeUnsafe(nowMs), autoResume: true, snooze: true }));
    yield* run(projections.getSettlementCandidates());
    yield* run(projections.getThreadsWithPullRequests());
    yield* run(projections.getThreadWorktreePaths());
    yield* run(projections.getUnreadableThreadIds());
    yield* run(compactEvents(nowMs));
    yield* run(runRetention);
    yield* run(threadOfPiSession("session-without-a-thread"));
    yield* run(piSessionOfThread(threads[1]!));
    // The bridge's backfill, per thread: its messages and its provider-session events.
    yield* run(threadMessages(threadId));
    yield* run(threadStreamGaps(threadId));

    const checked = recorded.filter(({ query }) => /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(query));
    assert.isAbove(checked.length, 20, "the reads above ran");
    const leading = new Map<string, string>();
    const partial = new Set<string>();
    for (const { name, definition } of yield* sql<{ readonly name: string; readonly definition: string | null }>`
      SELECT name, sql AS definition FROM sqlite_master WHERE type = 'index'`) {
      const columns = yield* sql<{ readonly name: string | null }>`SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
      if (columns[0]?.name) leading.set(name, columns[0].name);
      if (definition !== null && /\)\s*WHERE\b/i.test(definition)) partial.add(name);
    }
    // The server plans without statistics: upstream clears them whenever it opens the file
    // (persistence/Sqlite.ts) and nothing above collects them again, so SQLite plans with its
    // defaults, the same on this fixture as on a heavy database.
    const stats = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`;
    if ((stats[0]?.n ?? 0) > 0) assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_stat1`, [], "no statistics");
    const offenders: Array<string> = [];
    for (const { query, params } of checked) {
      const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
      const reads = fullReads(query, plan.map((row) => row.detail), (index) => leading.get(index), (index) => partial.has(index));
      if (reads.length > 0) offenders.push(`${reads.join(" | ")}\n  ${query.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    assert.deepStrictEqual(offenders, []);
    // The inventory's lookup by session (every five seconds per running session) seeks its index.
    for (const [field, index] of [["'$.nativeThreadRef.nativeId') =", "rubato_provider_threads_native_idx"],
      ["'$.sessionId') =", "rubato_provider_session_runtime_session_idx"]] as const) {
      const statement = checked.find(({ query }) => query.includes(field));
      assert.isDefined(statement, field);
      const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement!.query}`, statement!.params);
      assert.isTrue(plan.some((row) => row.detail.includes(index)), `${index}: ${plan.map((row) => row.detail).join(" | ")}`);
    }
  }).pipe(Effect.provide(layer)));

it("a plan step counts only when it scans a large table, under its own name or its alias", () => {
  const query = "SELECT t.thread_id FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id WHERE i.type = ?";
  assert.deepStrictEqual(fullReads(query, ["SCAN i", "SEARCH t USING INDEX sqlite_autoindex (thread_id=?)"]), ["SCAN i"]);
  assert.deepStrictEqual(fullReads(query, ["SEARCH i USING INDEX orchestration_v2_projection_turn_items_thread_run_idx (thread_id=?)", "SCAN t"]), []);
  assert.deepStrictEqual(fullReads("SELECT MAX(sequence) FROM orchestration_events WHERE x = 1",
    ["SEARCH orchestration_events USING COVERING INDEX idx_orchestration_events_agent_stream_sequence"]),
    ["SEARCH orchestration_events USING COVERING INDEX idx_orchestration_events_agent_stream_sequence"]);
  assert.deepStrictEqual(fullReads("SELECT sequence FROM orchestration_events WHERE x = 1",
    ["SEARCH orchestration_events USING INDEX idx_orchestration_events_application_sequence (application_event_version=?)"]), []);
  assert.deepStrictEqual(fullReads("SELECT MAX(sequence) AS last FROM orchestration_events", ["SEARCH orchestration_events"]), []);
  const leading = (index: string) => ({ idx_orchestration_events_application_high_water: "sequence",
    idx_orchestration_events_agent_stream_sequence: "stream_id" } as Record<string, string>)[index];
  assert.deepStrictEqual(fullReads("SELECT MAX(sequence) AS sequence FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water WHERE aggregate_kind = 'project'",
    ["SEARCH orchestration_events USING INDEX idx_orchestration_events_application_high_water"], leading), []);
  assert.lengthOf(fullReads("SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events WHERE application_event_version = 2",
    ["SEARCH orchestration_events USING COVERING INDEX idx_orchestration_events_agent_stream_sequence"], leading), 1);
  // A partial index holds only the rows its WHERE admits; a whole index does not.
  const failures = "SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure WHERE failure.type = 'error'";
  const isPartial = (index: string) => index === "turn_items_usage_limit_idx";
  assert.deepStrictEqual(fullReads(failures, ["SCAN failure USING INDEX turn_items_usage_limit_idx"], leading, isPartial), []);
  assert.lengthOf(fullReads(failures, ["SCAN failure USING INDEX turn_items_thread_idx"], leading, isPartial), 1);
  // One alias for a large table and for a CTE: a step reads the CTE when the plan builds it.
  const window = `WITH work_segments AS (SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
    WHERE item.thread_id = ?) SELECT * FROM work_segments item CROSS JOIN orchestration_v2_projection_turn_items AS item`;
  assert.deepStrictEqual(fullReads(window, ["MATERIALIZE work_segments", "SEARCH item USING INDEX turn_items_thread_idx (thread_id=?)",
    "SCAN item"]), []);
  assert.deepStrictEqual(fullReads(window, ["SCAN item"]), ["SCAN item"]);
});
