// Rubato: the headers a Rubato route on a paired Mac gets (rubatoEnvironmentHttp.ts).
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { rubatoEnvironmentAuthorization } from "./rubatoEnvironmentHttp.ts";

const DIRECT = { connectionId: "bearer:env-mac:https://wy-mac.tail.ts.net/", httpBaseUrl: "https://wy-mac.tail.ts.net/" };
const URL_ = "https://wy-mac.tail.ts.net/rubato/companion/companions";

function services() {
  const renewals: Array<string | undefined> = [];
  const proofs: Array<ManagedRelay.ManagedRelayDpopProofInput> = [];
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("unexpected"),
    authorizeDpop: () => Effect.die("unexpected"),
    authorizeDirectDpop: () => Effect.die("unexpected"),
    authorizeDpopHttp: () => Effect.die("a Rubato route is never reached through the relay"),
    authorizeDirectDpopHttp: (_connection, rejected) =>
      Effect.sync(() => {
        renewals.push(rejected);
        return {
          _tag: "Dpop" as const,
          accessToken: rejected ? "renewed-token" : "current-token",
          expiresAtEpochMs: 3_600_000,
          directConnection: DIRECT,
        };
      }),
    rememberCheckedDescriptor: () => Effect.void,
    renewDpopBeforeExpiry: () => Effect.die("unexpected"),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
      Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, signer),
    );
  return { renewals, proofs, provide };
}

const dpop = { _tag: "Dpop" as const, accessToken: "stale", expiresAtEpochMs: 0, directConnection: DIRECT };

describe("a Rubato route's authorization", () => {
  it.effect("carries an older pairing's bearer as it is", () =>
    Effect.gen(function* () {
      const result = yield* rubatoEnvironmentAuthorization({ httpAuthorization: { _tag: "Bearer", token: "session" } }, "POST", URL_);
      expect(result).toEqual({ headers: { authorization: "Bearer session" }, dpopAccessToken: null });
    }),
  );

  it.effect("signs a DPoP-bound token for this method and URL", () => {
    const { renewals, proofs, provide } = services();
    return Effect.gen(function* () {
      const result = yield* rubatoEnvironmentAuthorization({ httpAuthorization: dpop }, "POST", URL_);
      expect(result).toEqual({
        headers: { authorization: "DPoP current-token", dpop: "proof-1" },
        dpopAccessToken: "current-token",
      });
      expect(renewals).toEqual([undefined]);
      expect(proofs).toEqual([{ method: "POST", url: URL_, accessToken: "current-token" }]);
    }).pipe(provide);
  });

  it.effect("renews a token the Mac turned down", () => {
    const { renewals, provide } = services();
    return Effect.gen(function* () {
      const result = yield* rubatoEnvironmentAuthorization({ httpAuthorization: dpop }, "POST", URL_, "current-token");
      expect(result?.headers.authorization).toBe("DPoP renewed-token");
      expect(renewals).toEqual(["current-token"]);
    }).pipe(provide);
  });

  it.effect("has nothing for a relay connection, which has no Rubato routes", () =>
    Effect.gen(function* () {
      const relay = { _tag: "Dpop" as const, accessToken: "relay", expiresAtEpochMs: 0 };
      expect(yield* rubatoEnvironmentAuthorization({ httpAuthorization: relay }, "POST", URL_)).toBeNull();
    }),
  );
});
