import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { clearPersistedCloudLink, setCliDesiredCloudLink } from "./cloud/CliState.ts";
import * as CliTokenManager from "./cloud/CliTokenManager.ts";
import {
  CLOUD_LINKED_USER_ID,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./cloud/config.ts";
import { reconcileDesiredCloudLink } from "./cloud/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// Settings > Phone. The T3 app on a phone only shows a notification when this
// server publishes agent activity to T3's relay, which pushes it through APNs.
// That needs this environment linked to a T3 account — the same thing
// `t3 connect link --publish-only` does, without a terminal: sign in with a
// device code, then link at once instead of on the next start. No tunnel is
// made; the phone still reaches this Mac over Tailscale.

export type PhoneLogin =
  | { readonly phase: "idle" }
  | { readonly phase: "code"; readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number }
  | { readonly phase: "linking" }
  | { readonly phase: "error"; readonly message: string };

export interface PhoneStatus {
  /** The T3 account this Mac signed in with, when one is stored. */
  readonly account: string | null;
  readonly signedIn: boolean;
  /** The relay accepted this environment, so publishing has somewhere to go. */
  readonly linked: boolean;
  readonly notifications: boolean;
  readonly login: PhoneLogin;
}

const ROUTE = "/rubato/phone";

function decode(bytes: Option.Option<Uint8Array>): string | null {
  return Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null;
}

/** What a failed sign-in or link says to a person, without the stack. */
export function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.trim() || "Could not connect this Mac to T3.";
}

function json(body: unknown, status = 200) {
  return HttpServerResponse.jsonUnsafe(body, { status });
}

export const rubatoPhoneRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const server = yield* HttpServer.HttpServer;
    // The sign-in outlives the request that starts it, so it runs on the
    // services this layer was built with.
    const context = yield* Effect.context<
      | ServerSecretStore.ServerSecretStore
      | CliTokenManager.CloudCliTokenManager
      | ServerEnvironment.ServerEnvironment
      | HttpClient.HttpClient
      | EnvironmentAuth
      | Effect.Services<ReturnType<typeof reconcileDesiredCloudLink>>
    >();
    const runFork = Effect.runForkWith(context);

    let login: PhoneLogin = { phase: "idle" };
    let running: Fiber.Fiber<void> | null = null;

    const localOrigin = () => {
      const address = server.address;
      return typeof address === "string" || !("port" in address) ? null : `http://127.0.0.1:${address.port}`;
    };

    const status = Effect.gen(function* () {
      const token = yield* tokens.getExisting.pipe(Effect.orElseSucceed(() => Option.none<CliTokenManager.PersistedToken>()));
      const [linkedUser, credential, publish] = yield* Effect.all([
        secrets.get(CLOUD_LINKED_USER_ID),
        secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
      ]);
      return {
        account: Option.isSome(token) ? (token.value.identity ?? null) : null,
        signedIn: Option.isSome(token),
        linked: Option.isSome(linkedUser) && Option.isSome(credential),
        notifications: decode(publish) === "true",
        login,
      } satisfies PhoneStatus;
    });

    // Sign in when no credential is stored, then link publish-only right away.
    const connect = Effect.gen(function* () {
      if (running !== null) return yield* status;
      const origin = localOrigin();
      if (origin === null) {
        login = { phase: "error", message: "This server has no local address to link." };
        return yield* status;
      }
      const started = yield* Deferred.make<void>();
      login = { phase: "linking" };
      const flow = Effect.gen(function* () {
        const existing = yield* tokens.getExisting.pipe(
          Effect.orElseSucceed(() => Option.none<CliTokenManager.PersistedToken>()),
        );
        if (Option.isNone(existing)) {
          const { token } = yield* CliTokenManager.deviceAuthorizationLogin((prompt) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                login = {
                  phase: "code",
                  userCode: prompt.userCode,
                  verificationUri: prompt.verificationUriComplete ?? prompt.verificationUri,
                  expiresAt: now + Duration.toMillis(prompt.expiresIn),
                };
              }),
              Effect.andThen(Deferred.succeed(started, undefined)),
            ),
          );
          yield* tokens.store(token);
          login = { phase: "linking" };
        }
        yield* setCliDesiredCloudLink(true, "publish_only");
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
        yield* reconcileDesiredCloudLink(origin);
        login = { phase: "idle" };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            login = Cause.hasInterruptsOnly(cause) ? { phase: "idle" } : { phase: "error", message: failureMessage(cause) };
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running = null;
          }).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
        ),
      );
      running = runFork(flow);
      // Answer once there is a code to show, or the link already finished.
      yield* Deferred.await(started).pipe(Effect.timeout("20 seconds"), Effect.ignore);
      return yield* status;
    });

    const cancel = Effect.gen(function* () {
      const fiber = running;
      if (fiber !== null) yield* Fiber.interrupt(fiber);
      login = { phase: "idle" };
      return yield* status;
    });

    const setNotifications = (enabled: boolean) =>
      secrets
        .set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode(String(enabled)))
        .pipe(Effect.andThen(status));

    // Revoke the link at the relay when it answers, forget it here either way,
    // and sign out so another account can be used next time.
    const disconnect = Effect.gen(function* () {
      yield* cancel;
      const token = yield* tokens.getExisting.pipe(Effect.orElseSucceed(() => Option.none<CliTokenManager.PersistedToken>()));
      const relayUrl = decode(yield* secrets.get(RELAY_URL_SECRET));
      if (Option.isSome(token) && relayUrl) {
        const environmentId = yield* environment.getEnvironmentId;
        yield* HttpClientRequest.delete(
          `${relayUrl.replace(/\/+$/, "")}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
        ).pipe(
          HttpClientRequest.bearerToken(token.value.accessToken),
          httpClient.execute,
          Effect.timeout("10 seconds"),
          Effect.ignore,
        );
      }
      yield* clearPersistedCloudLink;
      yield* tokens.clear.pipe(Effect.ignore);
      return yield* status;
    });

    const answer = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const action = new URL(request.url, "http://local").pathname.replace(/\/+$/, "").split("/").at(-1);
        const body = ((yield* request.json.pipe(Effect.orElseSucceed(() => null))) ?? {}) as Record<string, unknown>;
        switch (action) {
          case "status":
            return json(yield* status);
          case "connect":
            return json(yield* connect);
          case "cancel":
            return json(yield* cancel);
          case "notifications":
            if (typeof body.enabled !== "boolean")
              return json({ error: { code: "invalid", message: "enabled must be true or false.", field: "enabled" } }, 400);
            return json(yield* setNotifications(body.enabled));
          case "disconnect":
            return json(yield* disconnect);
          default:
            return json({ error: { code: "unknown-action", message: `Unknown phone action: ${action}` } }, 404);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(json({ error: { code: "phone-failed", message: failureMessage(cause) } }, 500)),
        ),
      );

    return HttpRouter.add(
      "*",
      `${ROUTE}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        return yield* answer(request);
      }),
    );
  }),
);
