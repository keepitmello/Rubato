import { ClientSettingsPatch, ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

describe("Projects on the new-thread screen", () => {
  it("is off until turned on", () => {
    expect(DEFAULT_CLIENT_SETTINGS.rubatoHomeProjects).toBe(false);
    expect(Schema.decodeSync(ClientSettingsSchema)({}).rubatoHomeProjects).toBe(false);
  });

  it("keeps the choice once turned on", () => {
    expect(
      Schema.decodeSync(ClientSettingsPatch)({ rubatoHomeProjects: true }).rubatoHomeProjects,
    ).toBe(true);
    expect(
      Schema.decodeSync(ClientSettingsSchema)({ rubatoHomeProjects: true }).rubatoHomeProjects,
    ).toBe(true);
  });
});
