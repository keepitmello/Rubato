import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { senpiDir } from "../../src/engine-paths.mjs";
import { load } from "../../src/no-changelog-hooks.mjs";

const root = join(senpiDir, "dist/core/extensions/builtin");

async function loaded(relative) {
  const url = pathToFileURL(join(root, relative)).href;
  const source = readFileSync(join(root, relative), "utf8");
  const output = await load(url, { format: "module" }, async () => ({ format: "module", source }));
  return String(output.source);
}

async function moduleFor(relative) {
  return import(`data:text/javascript;base64,${Buffer.from(await loaded(relative)).toString("base64")}`);
}

function api(active, registered = ["eval", "bash", "monitor"]) {
  return { getAllTools: () => registered.map((name) => ({ name })), getActiveTools: () => active };
}

test("loaded terminal prompt uses direct calls when eval and native tools coexist", async () => {
  const { isEvalOnlyRouting } = await moduleFor("eval-only-routing.js");
  const { buildTerminalPromptSection } = await moduleFor("terminal/prompt.js");
  const pi = api(["eval", "bash", "monitor"]);
  const prompt = buildTerminalPromptSection({
    bashEvalOnly: isEvalOnlyRouting(pi, "bash"),
    monitorEvalOnly: isEvalOnlyRouting(pi, "monitor"),
  });
  assert.match(prompt, /`bash\(\{ command, run_in_background: true \}\)`/);
  assert.match(prompt, /`monitor\(\{ description, command, filter\?/);
  assert.doesNotMatch(prompt, /tool\.(bash|monitor)/);
});

test("partial SDK overrides render bash and monitor independently", async () => {
  const { isEvalOnlyRouting } = await moduleFor("eval-only-routing.js");
  const { buildTerminalPromptSection } = await moduleFor("terminal/prompt.js");
  for (const hidden of ["bash", "monitor"]) {
    const pi = api(["eval", hidden === "bash" ? "monitor" : "bash"]);
    const prompt = buildTerminalPromptSection({
      bashEvalOnly: isEvalOnlyRouting(pi, "bash"),
      monitorEvalOnly: isEvalOnlyRouting(pi, "monitor"),
    });
    assert.ok(prompt.includes(`tool.${hidden}`));
    assert.ok(!prompt.includes(`tool.${hidden === "bash" ? "monitor" : "bash"}`));
  }
});

test("routing helper does not invent an eval path for absent tools or partial hosts", async () => {
  const { isEvalOnlyRouting } = await moduleFor("eval-only-routing.js");
  assert.equal(isEvalOnlyRouting({}), false);
  assert.equal(isEvalOnlyRouting({ getAllTools: () => [{ name: "eval" }] }), false);
  assert.equal(isEvalOnlyRouting(api([], ["bash", "monitor"])), false);
  assert.equal(isEvalOnlyRouting(api(["eval"], ["eval"])), false);
});

test("installed terminal extension passes both actual per-tool routes to its prompt", async () => {
  const source = await loaded("terminal/extension.js");
  assert.match(source, /bashEvalOnly: isEvalOnlyRouting\(pi, "bash"\)/);
  assert.match(source, /monitorEvalOnly: isEvalOnlyRouting\(pi, "monitor"\)/);
  assert.doesNotMatch(source, /buildTerminalPromptSection\(\{ evalOnly: isEvalOnlyRouting\(pi\)/);
});

test("actual bash and monitor descriptions do not teach eval-only calls", async () => {
  const { createPtyBashTool } = await import(pathToFileURL(join(root, "terminal/tools/bash.js")));
  const { createMonitorTool } = await import(pathToFileURL(join(root, "terminal/tools/monitor.js")));
  for (const tool of [createPtyBashTool({}), createMonitorTool({})]) {
    const guidance = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");
    assert.doesNotMatch(guidance, /tool\.(bash|monitor)|ONLY inside eval|eval cell/);
    assert.ok(tool.parameters);
  }
});
