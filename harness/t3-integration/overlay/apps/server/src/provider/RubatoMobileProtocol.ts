import { ORCHESTRATION_WS_METHODS, WS_METHODS, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { RpcServer } from "effect/unstable/rpc";
import { makeRubatoMobilePresentation } from "./RubatoMobilePresentation.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Protocol = RpcServer.Protocol["Service"];
class MobileSelectionError extends Data.TaggedError("RubatoMobileSelectionError")<{
  readonly message: string;
}> {}

// Only presentation-bearing RPCs are inspected. Tool results, message text,
// terminals, file contents, usage totals, and provider maintenance pass through.
const outgoing = new Set<string>([
  WS_METHODS.serverGetConfig, WS_METHODS.serverRefreshProviders, WS_METHODS.subscribeServerConfig,
  WS_METHODS.serverGetSettings, WS_METHODS.serverUpdateSettings,
  ORCHESTRATION_WS_METHODS.subscribeShell, ORCHESTRATION_WS_METHODS.subscribeThread,
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
]);

export function withRubatoMobilePresentation(
  protocol: Protocol,
  options: {
    readonly surface?: string;
    readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly thread: (id: string) => Effect.Effect<unknown>;
  },
): Protocol {
  if (options.surface !== "mobile") return protocol;
  const requests = new Map<string, string>();
  let previous: ReadonlyArray<ServerProvider> | undefined;
  let presentation: ReturnType<typeof makeRubatoMobilePresentation> | undefined;
  const view = Effect.map(options.providers, providers => {
    if (providers !== previous) {
      presentation = makeRubatoMobilePresentation(providers);
      previous = providers;
    }
    return presentation!;
  });
  const key = (clientId: number, requestId: string | number) => `${clientId}:${requestId}`;
  const output = (method: string, value: unknown) => Effect.gen(function* () {
    const current = yield* view;
    switch (method) {
      case WS_METHODS.serverGetConfig:
      case WS_METHODS.serverRefreshProviders: return current.config(value);
      case WS_METHODS.subscribeServerConfig: return current.configItem(value);
      case WS_METHODS.serverGetSettings:
      case WS_METHODS.serverUpdateSettings: return current.settings(value);
      case ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot: return current.shell(value);
      case ORCHESTRATION_WS_METHODS.subscribeShell: return current.shellItem(value);
      case ORCHESTRATION_WS_METHODS.subscribeThread: {
        // A session-set detail event has no model. Only that event needs a
        // canonical thread lookup; token deltas never incur a DB read.
        const event = object(value) && value.kind === "event" && object(value.event) ? value.event : null;
        const id = event?.type === "thread.session-set" && object(event.payload)
          ? event.payload.threadId : null;
        const thread = typeof id === "string" ? yield* options.thread(id) : undefined;
        return current.detailItem(value, thread);
      }
      default: return value;
    }
  });

  return {
    ...protocol,
    run: write => protocol.run((clientId, message) => Effect.gen(function* () {
      if (message._tag !== "Request") return yield* write(clientId, message);
      if (outgoing.has(message.tag)) requests.set(key(clientId, message.id), message.tag);
      const method = message.tag;
      if (method !== ORCHESTRATION_WS_METHODS.dispatchCommand &&
          method !== WS_METHODS.serverRefreshProviders &&
          method !== WS_METHODS.serverUpdateSettings) return yield* write(clientId, message);
      const current = yield* view;
      // Bad/stale aliases fail this RPC, before any state mutation, rather than
      // crashing the connection or silently selecting another real instance.
      const mapped = yield* Effect.try({
        try: () => {
          if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) return current.command(message.payload);
          if (!object(message.payload)) return message.payload;
          if (method === WS_METHODS.serverUpdateSettings) {
            return { ...message.payload, patch: current.settings(message.payload.patch, true) };
          }
          return { ...message.payload,
            ...("instanceId" in message.payload ? { instanceId: current.restoreId(message.payload.instanceId) } : {}) };
        },
        catch: cause => new MobileSelectionError({
          message: cause instanceof Error ? cause.message : "Invalid Rubato mobile selection",
        }),
      }).pipe(Effect.result);
      if (mapped._tag === "Failure") {
        requests.delete(key(clientId, message.id));
        return yield* protocol.send(clientId, {
          _tag: "Exit", requestId: message.id,
          exit: { _tag: "Failure", cause: [{ _tag: "Die",
            defect: mapped.failure.message }] },
        });
      }
      return yield* write(clientId, { ...message, payload: mapped.success });
    })),
    send: (clientId, response, transferables) => Effect.gen(function* () {
      if (response._tag !== "Chunk" && response._tag !== "Exit") {
        return yield* protocol.send(clientId, response, transferables);
      }
      const id = key(clientId, response.requestId);
      const method = requests.get(id);
      if (response._tag === "Exit") requests.delete(id);
      if (!method) return yield* protocol.send(clientId, response, transferables);
      if (response._tag === "Chunk") {
        const values = yield* Effect.forEach(response.values, value => output(method, value));
        return yield* protocol.send(clientId, { ...response, values: values as [unknown, ...unknown[]] }, transferables);
      }
      if (response.exit._tag !== "Success") return yield* protocol.send(clientId, response, transferables);
      const value = yield* output(method, response.exit.value);
      return yield* protocol.send(clientId, { ...response, exit: { _tag: "Success", value } }, transferables);
    }),
  };
}
