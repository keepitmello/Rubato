import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { rubatoBridgeFor } from "./provider/Drivers/RubatoPiDriver.ts";
import type { PiBridge } from "./provider/Drivers/RubatoPiDriver.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { authorized } from "./RubatoServiceRoute.ts";
import { piSessionOf } from "./RubatoThreadFork.ts";

// The new-thread screen's "시스템 프롬프트" chip: a new conversation can open with another prompt
// in place of Rubato's own, as its whole system prompt. The library and the reading live in the
// bridge (session-prompts.mjs); these routes authenticate and hand over.
//
//   POST /rubato/session-prompts/list         { instanceId }                  { prompts, folder }
//   POST /rubato/session-prompts/open-folder  { instanceId }                  { folder }
//   POST /rubato/session-prompts/prepare      { instanceId, threadId, id }    { prompt }
//                                             { instanceId, threadId, text, label? }
//   POST /rubato/session-prompts/thread       { threadId }                    { prompt | null, started }
//
// `prepare` runs just before the thread's first message; the session that message opens is
// created with the prompt. `thread` names what a started thread runs on, never its text.

type Body = Record<string, unknown>;

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const text = (body: Body, key: string) =>
  typeof body[key] === "string" && (body[key] as string).length > 0 ? (body[key] as string) : undefined;

export const rubatoSessionPromptRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const registry = yield* ProviderInstanceRegistry;
    const directory = yield* ProviderSessionDirectory;

    const bridgeOf = (instanceId: string | undefined) =>
      Effect.gen(function* () {
        if (!instanceId) return undefined;
        const instance = yield* registry.getInstance(ProviderInstanceId.make(instanceId));
        return instance ? rubatoBridgeFor(instance) : undefined;
      });

    // The bridge refuses with a `code` (session-prompts.mjs SessionPromptError); it goes back as is.
    const call = <A>(run: () => Promise<A>, answer: (value: A) => Body) =>
      Effect.promise(() =>
        run().then(
          (value) => HttpServerResponse.jsonUnsafe(answer(value)),
          (cause: unknown) => {
            const code = (cause as { code?: unknown } | null)?.code;
            return failure(400, typeof code === "string" ? code : "failed", reason(cause));
          },
        ),
      );

    const withBridge = (body: Body, run: (bridge: PiBridge) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
      Effect.gen(function* () {
        const bridge = yield* bridgeOf(text(body, "instanceId"));
        if (!bridge) return failure(503, "unavailable", "The Rubato provider is not running.");
        return yield* run(bridge);
      });

    const list = (body: Body) =>
      withBridge(body, (bridge) =>
        call(
          async () => ({ prompts: await bridge.sessionPromptLibrary() }),
          (value) => value,
        ),
      );

    const openFolder = (body: Body) =>
      withBridge(body, (bridge) => call(() => bridge.openSessionPromptFolder(), (value) => value));

    const prepare = (body: Body) =>
      withBridge(body, (bridge) => {
        const threadId = text(body, "threadId");
        if (!threadId) return Effect.succeed(failure(400, "invalid", "threadId is missing."));
        const id = text(body, "id");
        const written = typeof body.text === "string" ? body.text : undefined;
        const label = text(body, "label");
        const choice = id ? { id } : { text: written ?? "", ...(label ? { label } : {}) };
        return call(() => bridge.prepareSessionPrompt(threadId, choice), (prompt) => ({ prompt }));
      });

    const thread = (body: Body) =>
      Effect.gen(function* () {
        const threadId = text(body, "threadId");
        if (!threadId) return failure(400, "invalid", "threadId is missing.");
        // `started: false` until the thread's first message binds a session; the badge asks again.
        const binding = yield* directory
          .getBinding(ThreadId.make(threadId))
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(binding)) return HttpServerResponse.jsonUnsafe({ prompt: null, started: false });
        const sessionId = piSessionOf(binding.value.resumeCursor);
        if (sessionId === null) return HttpServerResponse.jsonUnsafe({ prompt: null, started: true });
        const bridge = yield* bridgeOf(binding.value.providerInstanceId);
        if (!bridge) return HttpServerResponse.jsonUnsafe({ prompt: null, started: true });
        return yield* call(() => bridge.sessionPrompt(sessionId), (prompt) => ({ prompt, started: true }));
      });

    const route = (action: string, handle: (body: Body) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
      HttpRouter.add(
        "POST",
        `/rubato/session-prompts/${action}`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
          const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
          if (!body || typeof body !== "object") return failure(400, "invalid", "The request has no JSON body.");
          return yield* handle(body as Body);
        }),
      );

    return Layer.mergeAll(
      route("list", list),
      route("open-folder", openFolder),
      route("prepare", prepare),
      route("thread", thread),
    );
  }),
);
