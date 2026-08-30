import test from "node:test";
import assert from "node:assert/strict";
import { isTeamMemberProcess, parseMemberIdentity } from "../../src/member-identity.mjs";

test("parses a valid member identity and rejects a bare flag", () => {
  assert.equal(isTeamMemberProcess({}), false);
  assert.equal(isTeamMemberProcess({ SENPI_TASK_MEMBER: "x" }), true);
  assert.equal(parseMemberIdentity({ SENPI_TASK_MEMBER: "x" }).teamRunId, null);
  const parsed = parseMemberIdentity({
    SENPI_TASK_MEMBER: "11111111-1111-4111-8111-111111111111::owner-a",
    SENPI_TASK_TEAM_CONFIG: JSON.stringify({ stateDir: "/tmp/team" }),
  });
  assert.equal(parsed.memberName, "owner-a");
  assert.equal(parsed.stateDir, "/tmp/team");
});
