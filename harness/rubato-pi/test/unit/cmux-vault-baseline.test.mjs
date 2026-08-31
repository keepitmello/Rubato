import test from "node:test";
import assert from "node:assert/strict";
import { buildAgent, inspect } from "../../../scripts/cmux-vault.mjs";

const launcher = "/opt/rubato/harness/scripts/rubato-pi.sh";
const sessionPath = "{{sessionPath}}";

test("Vault resumes through attach-first live session dispatch", () => {
  const agent = buildAgent(launcher);
  assert.equal(agent.resumeCommand, `${launcher} vault-resume --session ${sessionPath}`);
  assert.equal(agent.sessionIdSource, "piSessionFile");
  assert.equal(agent.sessionDirectory, "~/.rubato-pi/agent/sessions");
  assert.equal(agent.cwd, "preserve");
});

test("Vault forks through an always-new live session dispatch", () => {
  const agent = buildAgent(launcher);
  assert.equal(agent.forkCommand, `${launcher} vault-fork --session ${sessionPath}`);
});

test("Vault inspection treats a different resume launcher as stale", () => {
  const current = buildAgent(launcher);
  assert.deepEqual(inspect({ vault: { agents: [current] } }, launcher), { state: "ok", found: current });
  assert.equal(
    inspect({ vault: { agents: [{ ...current, resumeCommand: "/old/rubato --session {{sessionPath}}" }] } }, launcher).state,
    "stale",
  );
  assert.deepEqual(inspect({ vault: { agents: [] } }, launcher), { state: "missing" });
});
