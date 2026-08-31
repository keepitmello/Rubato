import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("adapter leaves role contracts in the system prompts", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/extensions/adapter.mjs"), "utf8");
  assert.doesNotMatch(source, /contractSkills/);
  assert.doesNotMatch(source, /rubato-pi-contract-skills/);
  assert.match(source, /before_agent_start/);
});

test("member boot restores Agent tools without a second harness board registrar", () => {
  const adapter = readFileSync(join(import.meta.dirname, "../../src/extensions/adapter.mjs"), "utf8");
  const memberTools = readFileSync(join(import.meta.dirname, "../../src/member-tools.mjs"), "utf8");
  assert.match(adapter, /restoreMemberTaskEngine/);
  assert.doesNotMatch(adapter, /registerMemberBoardTools/);
  assert.doesNotMatch(adapter, /parseMemberIdentity/);
  assert.doesNotMatch(memberTools, /delete process\.env\.SENPI_TASK_MEMBER/);
  assert.doesNotMatch(memberTools, /team_task_list/);
  assert.doesNotMatch(memberTools, /team_task_get/);
  assert.doesNotMatch(memberTools, /team_task_update/);
});
