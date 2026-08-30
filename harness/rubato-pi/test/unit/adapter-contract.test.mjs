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
