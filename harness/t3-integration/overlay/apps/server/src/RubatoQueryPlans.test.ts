// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off -- fixtures are dated against the real clock
// The GUI server has one synchronous SQLite connection, so one statement that reads a large table
// whole stops every request (state-query-edits.mjs). This runs the server's hot reads and the
// state retention against a database built by the real migrations, records every statement they
// send, and asks SQLite how it would run each one: a plan that walks a large table from end to
// end fails, whichever code sent it.
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
import { piSessionOfThread, threadOfPiSession } from "./provider/RubatoPiSessions.ts";
import { RETENTION, compactEvents, ensureLookupIndexes, refreshStatistics, runRetention } from "./RubatoStateRetention.ts";

/**
 * Tables that grow with every turn: no statement may read one from end to end. Tables with a row
 * per thread (threads, provider threads) stay in the thousands and may be read whole.
 */
export const LARGE_TABLES = [
  "orchestration_events", "orchestration_v2_projection_turn_items", "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_messages", "rubato_retention_newest",
];
/**
 * The planner's statistics of a heavy user's database (750k events, 77k turn items), sampled
 * from one with the stale entries ANALYZE corrects (refreshStatistics). With the fixture's own
 * statistics SQLite reads every few-row table whole, which says nothing about a large one.
 */
const HEAVY_DATABASE_STATS: ReadonlyArray<readonly [table: string, index: string, stat: string]> = [
  ["orchestration_events", "idx_orch_events_command_id", "425121 4"],
  ["orchestration_events", "idx_orch_events_correlation_id", "425121 4"],
  ["orchestration_events", "idx_orch_events_stream_sequence", "425121 506 11 1"],
  ["orchestration_events", "idx_orch_events_stream_version", "425121 506 11 1"],
  ["orchestration_events", "idx_orchestration_events_agent_stream_sequence", "746739 340 1"],
  ["orchestration_events", "idx_orchestration_events_application_high_water", "349 1"],
  ["orchestration_events", "idx_orchestration_events_application_sequence", "425121 590 1"],
  ["orchestration_events", "orchestration_events_v2_created_threads_idx", "2217 1"],
  ["orchestration_events", "sqlite_autoindex_orchestration_events_1", "425121 1"],
  ["orchestration_v2_projection_messages", "orchestration_v2_projection_messages_latest_user_idx", "11306 10 1 1"],
  ["orchestration_v2_projection_messages", "orchestration_v2_projection_messages_node_idx", "77313 146"],
  ["orchestration_v2_projection_messages", "orchestration_v2_projection_messages_run_idx", "77313 339"],
  ["orchestration_v2_projection_messages", "orchestration_v2_projection_messages_thread_created_idx", "77313 41 1 1"],
  ["orchestration_v2_projection_messages", "sqlite_autoindex_orchestration_v2_projection_messages_1", "77313 1"],
  ["orchestration_v2_projection_nodes", "orchestration_v2_projection_nodes_live_idx", "0 0"],
  ["orchestration_v2_projection_nodes", "orchestration_v2_projection_nodes_parent_idx", "18336 46"],
  ["orchestration_v2_projection_nodes", "orchestration_v2_projection_nodes_provider_turn_idx", "18336 51"],
  ["orchestration_v2_projection_nodes", "orchestration_v2_projection_nodes_thread_run_idx", "18336 203 25"],
  ["orchestration_v2_projection_nodes", "sqlite_autoindex_orchestration_v2_projection_nodes_1", "18336 1"],
  ["orchestration_v2_projection_provider_session_bindings", "orchestration_v2_projection_provider_session_bindings_thread_idx", "150 1"],
  ["orchestration_v2_projection_provider_session_bindings", "sqlite_autoindex_orchestration_v2_projection_provider_session_bindings_1", "150 1 1"],
  ["orchestration_v2_projection_provider_sessions", "orchestration_v2_projection_provider_sessions_instance_status_idx", "178 178 89"],
  ["orchestration_v2_projection_provider_sessions", "orchestration_v2_projection_provider_sessions_provider_status_idx", "178 178 89"],
  ["orchestration_v2_projection_provider_sessions", "orchestration_v2_projection_provider_sessions_thread_idx", "178 1"],
  ["orchestration_v2_projection_provider_sessions", "sqlite_autoindex_orchestration_v2_projection_provider_sessions_1", "178 1"],
  ["orchestration_v2_projection_provider_threads", "orchestration_v2_projection_provider_threads_instance_status_idx", "555 555 278"],
  ["orchestration_v2_projection_provider_threads", "orchestration_v2_projection_provider_threads_owner_idx", "555 555"],
  ["orchestration_v2_projection_provider_threads", "orchestration_v2_projection_provider_threads_session_idx", "555 2"],
  ["orchestration_v2_projection_provider_threads", "orchestration_v2_projection_provider_threads_thread_idx", "555 1"],
  ["orchestration_v2_projection_provider_threads", "sqlite_autoindex_orchestration_v2_projection_provider_threads_1", "555 1"],
  ["orchestration_v2_projection_provider_turns", "orchestration_v2_projection_provider_turns_thread_idx", "6158 27"],
  ["orchestration_v2_projection_provider_turns", "orchestration_v2_projection_provider_turns_thread_ordinal_idx", "6158 19 1"],
  ["orchestration_v2_projection_provider_turns", "sqlite_autoindex_orchestration_v2_projection_provider_turns_1", "6158 1"],
  ["orchestration_v2_projection_runs", "orchestration_v2_projection_runs_provider_thread_idx", "837 12"],
  ["orchestration_v2_projection_runs", "orchestration_v2_projection_runs_recovery_idx", "0 0 0"],
  ["orchestration_v2_projection_runs", "orchestration_v2_projection_runs_thread_ordinal_idx", "837 12 1"],
  ["orchestration_v2_projection_runs", "orchestration_v2_projection_runs_thread_status_idx", "837 12 7"],
  ["orchestration_v2_projection_runs", "sqlite_autoindex_orchestration_v2_projection_runs_1", "837 1"],
  ["orchestration_v2_projection_threads", "orchestration_v2_projection_threads_project_updated_idx", "1495 12 1"],
  ["orchestration_v2_projection_threads", "sqlite_autoindex_orchestration_v2_projection_threads_1", "1495 1"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_failed_error_idx", "169 10 3 1 1 1 1"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_node_ordinal_idx", "77328 52 47"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_provider_turn_idx", "77328 343"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_recovery_idx", "0 0"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_run_ordinal_idx", "77328 344 47"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_shell_pending_idx", "0 0 0"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_thread_ordinal_idx", "77328 41 1 1"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_thread_run_idx", "77328 41 41"],
  ["orchestration_v2_projection_turn_items", "orchestration_v2_projection_turn_items_user_message_idx", "11306 10 1 1"],
  ["orchestration_v2_projection_turn_items", "sqlite_autoindex_orchestration_v2_projection_turn_items_1", "77328 1"],
  ["orchestration_v2_turn_item_positions", "sqlite_autoindex_orchestration_v2_turn_item_positions_1", "77328 41 1"],
  ["orchestration_v2_turn_item_positions", "sqlite_autoindex_orchestration_v2_turn_item_positions_2", "77328 41 1"],
  ["provider_session_runtime", "idx_provider_session_runtime_instance", "1470 337"],
  ["provider_session_runtime", "idx_provider_session_runtime_provider", "1470 337"],
  ["provider_session_runtime", "idx_provider_session_runtime_status", "1470 1011"],
  ["provider_session_runtime", "sqlite_autoindex_provider_session_runtime_1", "1470 1"],
  ["orchestration_v2_projection_provider_threads", "rubato_provider_threads_native_idx", "555 278 1"],
  ["provider_session_runtime", "rubato_provider_session_runtime_session_idx", "1470 337 1"],
  ["rubato_retention_newest", "rubato_retention_newest", "400000 6 2000 1"],
];
/**
 * What the same database's statistics said before a refresh: indexes analyzed while still empty
 * stay listed as empty under upstream's `PRAGMA optimize` (refreshStatistics).
 */
const STALE_ENTRIES: Readonly<Record<string, string>> = {
  idx_orchestration_events_agent_stream_sequence: "0 0 0",
  orchestration_events_v2_created_threads_idx: "0 0",
  orchestration_v2_projection_turn_items_failed_error_idx: "0 0 0 0 0 0 0",
};

/** Gives the large tables a heavy database's statistics and has the connection read them. */
const useHeavyStatistics = (stale: boolean) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const heavyTables = [...new Set(HEAVY_DATABASE_STATS.map(([table]) => table))];
  yield* sql`DELETE FROM sqlite_stat1 WHERE tbl IN ${sql.in(heavyTables)}`;
  // The fixture's sampled rows would outweigh the heavy statistics for range estimates.
  const stat4 = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat4'`;
  if ((stat4[0]?.n ?? 0) > 0) yield* sql`DELETE FROM sqlite_stat4 WHERE tbl IN ${sql.in(heavyTables)}`;
  for (const [table, index, stat] of HEAVY_DATABASE_STATS)
    yield* sql`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (${table}, ${index}, ${(stale ? STALE_ENTRIES[index] : undefined) ?? stat})`;
  yield* sql.unsafe("ANALYZE sqlite_schema").raw;
});

const NOT_A_NAME = new Set(["where", "on", "indexed", "not", "left", "inner", "cross", "join", "order", "group",
  "limit", "using", "set", "values", "select", "natural", "outer", "as"]);

/** Each table the statement names, under the name SQLite's plan uses for it (its alias, if any). */
export const tablesOf = (query: string) => {
  const names = new Map<string, string>();
  for (const match of query.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
    const table = match[1]!.toLowerCase();
    const alias = match[2]?.toLowerCase();
    names.set(alias !== undefined && !NOT_A_NAME.has(alias) ? alias : table, table);
  }
  return names;
};

/**
 * The plan steps that read a large table whole: a SCAN of it, bare or through an index, or a
 * SEARCH through an index with no condition on it, which is how SQLite shows MIN or MAX over an
 * index. That is one entry when the index starts with the column (`leadingColumn`), and the whole
 * index otherwise. A bare SEARCH of the table is the same seek on its primary key.
 */
export const fullReads = (query: string, details: ReadonlyArray<string>,
  leadingColumn: (index: string) => string | undefined = () => undefined) => {
  const tables = tablesOf(query);
  const extreme = /\b(?:MIN|MAX)\(\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\)/i.exec(query)?.[1]?.toLowerCase();
  return details.filter((detail) => {
    const step = /^(SCAN|SEARCH) ([a-z_][a-z0-9_]*)/i.exec(detail);
    if (step === null) return false;
    const table = step[2]!.toLowerCase();
    if (!LARGE_TABLES.includes(tables.get(table) ?? table)) return false;
    if (step[1]!.toUpperCase() === "SCAN") return true;
    const index = /USING (?:COVERING )?INDEX ([a-z_][a-z0-9_]*)/i.exec(detail)?.[1];
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
    // The server samples statistics before it serves (rubatoStateRetentionLayer).
    yield* refreshStatistics;

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

    const checked = recorded.filter(({ query }) => /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(query));
    assert.isAbove(checked.length, 20, "the reads above ran");
    const leading = new Map<string, string>();
    for (const { name } of yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'index'`) {
      const columns = yield* sql<{ readonly name: string | null }>`SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
      if (columns[0]?.name) leading.set(name, columns[0].name);
    }
    // Plan every statement as SQLite plans it on a heavy database, with current statistics and
    // with the stale ones an existing install still has until its first refresh. (The retention
    // pass above sampled this small fixture's statistics again.)
    for (const stale of [false, true]) {
      yield* useHeavyStatistics(stale);
      const offenders: Array<string> = [];
      for (const { query, params } of checked) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
        const reads = fullReads(query, plan.map((row) => row.detail), (index) => leading.get(index));
        if (reads.length > 0) offenders.push(`${reads.join(" | ")}\n  ${query.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      assert.deepStrictEqual(offenders, [], stale ? "stale statistics" : "current statistics");
    }
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
});
