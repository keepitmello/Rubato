import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { restoreLegacyFileRead, withLegacyFileRead } from "./RubatoLegacyGrants.ts";

// The grant the phone in the report carried, from a pairing link a V1 server issued.
const PHONE_PAIRED_ON_V1 = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as AuthEnvironmentScope[];

describe("file reading for clients paired before granular permissions", () => {
  it("lets a phone paired on an old server read files again", () => {
    expect(withLegacyFileRead(PHONE_PAIRED_ON_V1)).toContain(AuthFilesystemReadScope);
  });

  it("restores reading only, not the other permissions the old scopes implied", () => {
    const restored = withLegacyFileRead(PHONE_PAIRED_ON_V1);
    expect(restored).toEqual([...PHONE_PAIRED_ON_V1, AuthFilesystemReadScope]);
    expect(restored).not.toContain(AuthFilesystemWriteScope);
  });

  it("leaves a current grant alone, with or without file reading", () => {
    expect(withLegacyFileRead(AuthStandardClientScopes)).toBe(AuthStandardClientScopes);
    // A read-only pairing a current server issued: the old vocabulary, chosen on purpose.
    const readOnly = ["orchestration:read"] as AuthEnvironmentScope[];
    expect(withLegacyFileRead(readOnly)).toBe(readOnly);
  });

  it("leaves an old grant that could not read the conversation alone", () => {
    const relayOnly = ["review:write", "relay:read", "relay:write"] as AuthEnvironmentScope[];
    expect(withLegacyFileRead(relayOnly)).toBe(relayOnly);
  });

  it("returns the same session when nothing changes", () => {
    const session = { sessionId: "s", scopes: AuthStandardClientScopes };
    expect(restoreLegacyFileRead(session)).toBe(session);
    expect(restoreLegacyFileRead({ sessionId: "p", scopes: PHONE_PAIRED_ON_V1 }).scopes).toContain(
      AuthFilesystemReadScope,
    );
  });
});
