/**
 * Which Rubato (Pi) session an app thread runs in, and the other way round, on T3's V2
 * orchestrator. Three records can answer, newest first:
 *   1. the thread's V2 provider thread: its native thread id is the engine session id
 *      (bridge rpc-connection.mjs reports it as Pi's `sessionFile`);
 *   2. the V1 binding (`provider_session_runtime.resume_cursor_json`, copied into the V2
 *      database with the rest of the V1 tables), for conversations from before V2 that
 *      have not run since;
 *   3. the thread id itself for a session the inventory imported:
 *      `import:<instance>:<serverId>:<sessionId>`.
 */
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { rubatoBridgeFor, type PiBridge } from "./Drivers/RubatoPiDriver.ts";

export interface PiSessionRef {
  readonly sessionId: string;
  /** The engine the session lives in, when the record says; V2 provider threads do not. */
  readonly serverId: string | null;
}

const IMPORTED_THREAD = /^import:[^:]+:([^:]+):(.+)$/;
const DRIVER = "rubato-pi";

/** The session an inventory-imported thread's id names. */
export const importedPiSession = (threadId: string): PiSessionRef | null => {
  const match = IMPORTED_THREAD.exec(threadId);
  return match ? { serverId: match[1]!, sessionId: match[2]! } : null;
};

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
};
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** The Pi session `threadId` runs in, or null. */
export const piSessionOfThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The active provider thread first: after a provider switch an older Rubato
    // provider thread may remain, and the thread no longer runs in it.
    const providerThreads = yield* sql<{ readonly payload_json: string; readonly active: number }>`
      SELECT pt.payload_json AS payload_json,
        CASE WHEN t.active_provider_thread_id = pt.provider_thread_id THEN 1 ELSE 0 END AS active
      FROM orchestration_v2_projection_provider_threads pt
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.thread_id = ${threadId} AND pt.driver = ${DRIVER}
      ORDER BY active DESC, pt.updated_at DESC
      LIMIT 1
    `;
    const nativeId = text(field(field(parse(providerThreads[0]?.payload_json ?? null), "nativeThreadRef"), "nativeId"));
    if (nativeId !== null) return { sessionId: nativeId, serverId: null } satisfies PiSessionRef;
    const legacy = yield* sql<{ readonly resume_cursor_json: string | null }>`
      SELECT resume_cursor_json FROM provider_session_runtime
      WHERE thread_id = ${threadId} AND provider_name = ${DRIVER}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => []));
    const cursor = parse(legacy[0]?.resume_cursor_json ?? null);
    const sessionId = field(cursor, "kind") === DRIVER ? text(field(cursor, "sessionId")) : null;
    if (sessionId !== null) return { sessionId, serverId: text(field(cursor, "serverId")) } satisfies PiSessionRef;
    return importedPiSession(threadId);
  });

/** The live (not deleted) thread that runs in `sessionId`, or null. */
export const threadOfPiSession = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const live = (rows: ReadonlyArray<{ readonly thread_id: string }>) =>
      rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id);
    const fromProviderThread = live(yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id AS thread_id
      FROM orchestration_v2_projection_provider_threads pt
      JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.driver = ${DRIVER} AND t.deleted_at IS NULL
        AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
      ORDER BY pt.updated_at DESC
      LIMIT 1
    `);
    if (fromProviderThread !== null) return fromProviderThread;
    const fromLegacy = live(yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id AS thread_id
      FROM provider_session_runtime b
      JOIN orchestration_v2_projection_threads t ON t.thread_id = b.thread_id
      WHERE b.provider_name = ${DRIVER} AND t.deleted_at IS NULL
        AND json_extract(b.resume_cursor_json, '$.sessionId') = ${sessionId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [])));
    if (fromLegacy !== null) return fromLegacy;
    return live(yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND thread_id LIKE ${"import:%:" + sessionId}
      LIMIT 1
    `);
  });

/** The bridge of a Rubato provider instance: the named one, or the first enabled. */
export const rubatoBridge = (instanceId?: string) =>
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
    if (Option.isNone(registry)) return null;
    if (instanceId !== undefined) {
      const instance = yield* registry.value.getInstance(ProviderInstanceId.make(instanceId));
      return instance === undefined ? null : rubatoBridgeFor(instance) ?? null;
    }
    for (const instance of yield* registry.value.listInstances) {
      if (instance.driverKind !== DRIVER || !instance.enabled) continue;
      const bridge = rubatoBridgeFor(instance);
      if (bridge) return bridge;
    }
    return null;
  });

/**
 * Lets every Rubato bridge find the session a thread already runs in, so its first
 * turn on V2 continues that conversation instead of starting a new one. Bound again
 * whenever the registry rebuilds an instance.
 */
export const bindRubatoSessionLookup = Effect.gen(function* () {
  // Optional services: the startup layer's requirements stay what upstream declares.
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(registry) || Option.isNone(sql)) return;
  const bind = Effect.gen(function* () {
    for (const instance of yield* registry.value.listInstances) {
      const bridge: PiBridge | undefined = rubatoBridgeFor(instance);
      if (!bridge) continue;
      bridge.boundSession = (threadId: string) =>
        Effect.runPromise(piSessionOfThread(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql.value)));
    }
  });
  yield* bind;
  const changes = yield* registry.value.subscribeChanges;
  yield* Effect.forkScoped(Effect.forever(PubSub.take(changes).pipe(Effect.andThen(bind))));
});
