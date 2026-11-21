// Rubato: headers for one request to a Rubato route on a paired Mac (/rubato/companion, /rubato/call,
// /rubato/push, the Mac's live dictation, ...). Those routes authenticate with T3's own
// authenticateHttpRequest, so they take the same credentials T3's endpoints do: the session bearer of
// an older pairing, or a DPoP-bound access token with a proof for this method and URL. The token is
// renewed the way T3's requests renew it (RemoteEnvironmentAuthorization.authorizeDirectDpopHttp).
// Exported to the phone through package.json ("./state/rubatoEnvironmentHttp", mobile/companion-edits.mjs).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpMethod } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";

export interface RubatoEnvironmentAuthorization {
  readonly headers: Readonly<Record<string, string>>;
  /** The DPoP-bound token these headers carry; a request it fails with 401 may renew it once. */
  readonly dpopAccessToken: string | null;
}

export class RubatoEnvironmentAuthError extends Schema.TaggedError<RubatoEnvironmentAuthError>()(
  "RubatoEnvironmentAuthError",
  { message: Schema.String },
) {}

/**
 * The headers that authorize `method url` on this connection, or null when the connection cannot
 * reach Rubato's routes at all (a T3 Connect relay connection, which Rubato does not use).
 * `rejectedAccessToken` names a DPoP token the Mac just turned down, so a new one is issued.
 */
export const rubatoEnvironmentAuthorization = Effect.fn("rubato.environmentHttp.authorization")(function* (
  prepared: Pick<PreparedConnection, "httpAuthorization">,
  method: HttpMethod.HttpMethod,
  url: string,
  rejectedAccessToken?: string,
) {
  const authorization = prepared.httpAuthorization;
  if (authorization === null) return { headers: {}, dpopAccessToken: null } as RubatoEnvironmentAuthorization;
  if (authorization._tag === "Bearer")
    return { headers: { authorization: `Bearer ${authorization.token}` }, dpopAccessToken: null } as RubatoEnvironmentAuthorization;
  const direct = authorization.directConnection;
  if (direct === undefined) return null;
  const remote = yield* Effect.serviceOption(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization);
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  if (Option.isNone(remote) || Option.isNone(signer))
    return yield* new RubatoEnvironmentAuthError({ message: "This device cannot sign requests for the Mac." });
  const current = yield* remote.value.authorizeDirectDpopHttp(direct, rejectedAccessToken);
  const proof = yield* signer.value.createProof({ method, url, accessToken: current.accessToken });
  return {
    headers: { authorization: `DPoP ${current.accessToken}`, dpop: proof },
    dpopAccessToken: current.accessToken,
  } as RubatoEnvironmentAuthorization;
});
