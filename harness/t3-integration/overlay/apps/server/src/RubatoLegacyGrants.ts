/**
 * File reading for clients paired before T3 split its permissions (phone-edits.mjs).
 *
 * A pairing from a server before granular permissions carries the old vocabulary only:
 * `orchestration:read` then also meant reading the workspace's files. The current server
 * never widens a stored grant, so such a phone kept chatting but lost every image and file
 * preview: the T3 app checks the session for `filesystem:read` and draws "unavailable"
 * without asking the server. Rubato users upgrade in place, so every phone paired on V1
 * sits there until it is paired again.
 *
 * An old server's grant is told by `review:write`: those servers put it in every grant, and
 * a current one cannot issue it (contracts AuthGrantScope leaves it out). A grant a current
 * server issued without file reading, such as a read-only pairing, stays as chosen. An old
 * grant with `orchestration:read` reads files again, as it did when it was paired; nothing
 * else the old scopes implied comes back.
 */
import {
  AuthFilesystemReadScope,
  AuthGrantScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

/** The scope only an old server's grant holds. */
export const OLD_SERVER_ONLY_SCOPE = "review:write" satisfies AuthEnvironmentScope;
const issuedByOldServer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.includes(OLD_SERVER_ONLY_SCOPE) &&
  !(AuthGrantScope.literals as ReadonlyArray<string>).includes(OLD_SERVER_ONLY_SCOPE);

export function withLegacyFileRead(
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> {
  const legacy =
    issuedByOldServer(scopes) &&
    scopes.includes(AuthOrchestrationReadScope) &&
    !scopes.includes(AuthFilesystemReadScope);
  return legacy ? [...scopes, AuthFilesystemReadScope] : scopes;
}

/** The verified session with file reading restored for an old-only grant. */
export function restoreLegacyFileRead<Session extends { readonly scopes: ReadonlyArray<AuthEnvironmentScope> }>(
  session: Session,
): Session {
  const scopes = withLegacyFileRead(session.scopes);
  return scopes === session.scopes ? session : { ...session, scopes };
}
