import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { load } from "../../src/no-changelog-hooks.mjs";
import {
  injectAgentSession,
  injectEvalOnlyDirectTools,
} from "../../src/transforms/core-agent-session.mjs";

function agentSessionSource() {
  return readFileSync(join(senpiDir, "dist/core/agent-session.js"), "utf8");
}

function evalOnlySetFrom(source) {
  const match = source.match(/const EVAL_ONLY_TOOL_NAMES = new Set\((\[.*?\])\);/);
  assert.ok(match, "EVAL_ONLY_TOOL_NAMES initializer not found");
  return new Set(Function(`return ${match[1]}`)());
}

function resolveEvalOnly(config, defaults) {
  const override = config.evalOnlyToolNames ? new Set(config.evalOnlyToolNames) : undefined;
  return override ?? defaults;
}

function filterActive(toolNames, evalOnly) {
  return toolNames.filter((name) => !evalOnly.has(name));
}

const SHELL = ["bash", "powershell", "monitor"];
const REQUESTED = ["read", "bash", "powershell", "monitor", "eval", "write"];

test("pristine senpi withholds bash/powershell/monitor through eval-only", () => {
  const pristine = evalOnlySetFrom(agentSessionSource());
  for (const name of SHELL) assert.equal(pristine.has(name), true);
  assert.deepEqual(
    filterActive(REQUESTED, pristine),
    ["read", "eval", "write"],
  );
});

test("transform leaves shell tools active and keeps the SDK override", () => {
  const source = agentSessionSource();
  const next = injectEvalOnlyDirectTools(injectAgentSession(source));
  const armed = evalOnlySetFrom(next);
  for (const name of SHELL) assert.equal(armed.has(name), false);
  assert.deepEqual(filterActive(REQUESTED, armed), REQUESTED);
  assert.match(next, /_evalOnlyToolNamesOverride \?\? EVAL_ONLY_TOOL_NAMES/);
  assert.match(next, /config\.evalOnlyToolNames \? new Set\(config\.evalOnlyToolNames\)/);
  assert.match(next, /hooks and permissions still apply/);
  assert.deepEqual([...resolveEvalOnly({}, armed)], []);
  assert.deepEqual([...resolveEvalOnly({ evalOnlyToolNames: [] }, armed)], []);
  assert.deepEqual([...resolveEvalOnly({ evalOnlyToolNames: ["bash"] }, armed)], ["bash"]);
  assert.deepEqual(
    filterActive(REQUESTED, resolveEvalOnly({ evalOnlyToolNames: ["bash"] }, armed)),
    ["read", "powershell", "monitor", "eval", "write"],
  );
  assert.throws(() => injectEvalOnlyDirectTools(next), /eval-only shell tools/);
});

test("loader chain applies the empty eval-only default", async () => {
  const path = join(senpiDir, "dist/core/agent-session.js");
  const source = readFileSync(path, "utf8");
  const url = pathToFileURL(path).href;
  const result = await load(url, { format: "module" }, async () => ({ format: "module", source }));
  const next = String(result.source);
  const armed = evalOnlySetFrom(next);
  for (const name of SHELL) assert.equal(armed.has(name), false);
  assert.deepEqual(filterActive(REQUESTED, armed), REQUESTED);
  assert.match(next, /_evalOnlyToolNamesOverride \?\? EVAL_ONLY_TOOL_NAMES/);
});
