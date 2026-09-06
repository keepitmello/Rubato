import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import { SLIM_DESCRIPTIONS, slimToolDescription } from "../../src/tool-description-slim.mjs";
import {
  injectToolDescriptions,
  isToolDefinitionWrapperUrl,
  toolDescriptionHrefs,
} from "../../src/transforms/core-tool-descriptions.mjs";

const WRAPPER_REL = "dist/core/tools/tool-definition-wrapper.js";
const KNOWN = Object.keys(SLIM_DESCRIPTIONS);
const LONG = `${"catalog ".repeat(400)}END`;

function wrapperSource() {
  return readFileSync(join(senpiDir, WRAPPER_REL), "utf8");
}

async function loadWrapped(source) {
  const transformed = injectToolDescriptions(source);
  const href = `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Math.random()}`;
  return { transformed, mod: await import(href) };
}

function definition(name, extras = {}) {
  const parameters = extras.parameters ?? { type: "object", properties: { q: { type: "string" } } };
  const calls = [];
  const execute = (...args) => {
    calls.push(args);
    return { ok: true, name };
  };
  return {
    def: {
      name,
      label: `${name}-label`,
      description: extras.description ?? LONG,
      parameters,
      freeform: extras.freeform,
      constrainedSampling: extras.constrainedSampling ?? { mode: "json" },
      prepareArguments: extras.prepareArguments,
      executionMode: extras.executionMode ?? "parallel",
      execute,
    },
    parameters,
    execute,
    calls,
  };
}

test("isToolDefinitionWrapperUrl matches the installed wrapper only", () => {
  const path = join(senpiDir, WRAPPER_REL);
  assert.equal(isToolDefinitionWrapperUrl(pathToFileURL(path).href), true);
  assert.equal(
    isToolDefinitionWrapperUrl("file:///x/node_modules/@code-yeongyu/senpi/dist/core/tools/tool-definition-wrapper.js"),
    true,
  );
  assert.equal(isToolDefinitionWrapperUrl("file:///x/node_modules/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
  assert.equal(isToolDefinitionWrapperUrl(undefined), false);
});

test("transformed installed wrapper slims model-facing descriptions only", async () => {
  const source = wrapperSource();
  assert.match(source, /description: definition\.description,/);
  const { transformed, mod } = await loadWrapped(source);
  assert.match(transformed, /slimToolDescription\(definition\.name, definition\.description\)/);
  assert.equal(transformed.includes(toolDescriptionHrefs().slim), true);
  assert.throws(() => injectToolDescriptions(transformed), /tool-description/);

  const { wrapToolDefinition, wrapToolDefinitions, createToolDefinitionFromAgentTool } = mod;
  assert.equal(typeof wrapToolDefinition, "function");

  const ctx = { cwd: "/tmp" };
  for (const name of KNOWN) {
    const json = definition(name);
    Object.freeze(json.def);
    const wrapped = wrapToolDefinition(json.def, () => ctx);
    assert.equal(json.def.description, LONG, `${name} catalog description mutated`);
    assert.equal(wrapped.description, SLIM_DESCRIPTIONS[name]);
    assert.ok(wrapped.description.length * 2 < LONG.length, `${name} was not shortened`);
    assert.equal(wrapped.parameters, json.parameters);
    assert.equal(wrapped.freeform, undefined);
    assert.equal(wrapped.constrainedSampling, json.def.constrainedSampling);
    assert.equal(wrapped.executionMode, "parallel");
    assert.equal(wrapped.name, name);
    const signal = AbortSignal.abort();
    const onUpdate = () => {};
    const result = await wrapped.execute("call-1", { q: "x" }, signal, onUpdate);
    assert.deepEqual(result, { ok: true, name });
    assert.equal(json.calls.length, 1);
    assert.equal(json.calls[0][0], "call-1");
    assert.deepEqual(json.calls[0][1], { q: "x" });
    assert.equal(json.calls[0][4], ctx);

    const freeformMeta = { syntax: "text" };
    const free = definition(name, { freeform: freeformMeta, parameters: { type: "string" } });
    const wrappedFree = wrapToolDefinition(free.def);
    assert.equal(wrappedFree.freeform, freeformMeta);
    assert.equal(wrappedFree.parameters, free.parameters);
    assert.equal(free.def.description, LONG);
  }

  const unknown = definition("webfetch");
  const wrappedUnknown = wrapToolDefinition(unknown.def);
  assert.equal(wrappedUnknown.description, LONG);
  assert.equal(unknown.def.description, LONG);
  assert.equal(slimToolDescription("webfetch", LONG), LONG);

  const batch = wrapToolDefinitions(KNOWN.slice(0, 3).map((name) => definition(name).def));
  assert.deepEqual(
    batch.map((tool) => tool.description),
    KNOWN.slice(0, 3).map((name) => SLIM_DESCRIPTIONS[name]),
  );

  const rawAgent = {
    name: "todo",
    description: LONG,
    parameters: { type: "object" },
    execute: async () => ({ ok: true }),
  };
  const synthesized = createToolDefinitionFromAgentTool(rawAgent);
  assert.equal(synthesized.description, LONG);

  assert.equal(slimToolDescription("eval", LONG), LONG);
  assert.equal("eval" in SLIM_DESCRIPTIONS, false);
  assert.match(SLIM_DESCRIPTIONS.memory, /^Write markdown memories/);
  assert.doesNotMatch(SLIM_DESCRIPTIONS.memory, /Read or write/);
  assert.match(SLIM_DESCRIPTIONS.team_create, /LEAD\.md/);
  assert.match(SLIM_DESCRIPTIONS.team_create, /runtimes\/pi\.md/);
  assert.match(SLIM_DESCRIPTIONS.team_create, /smallest roster/);
  assert.match(SLIM_DESCRIPTIONS.Agent, /If no independent work remains, end the turn/);
  assert.doesNotMatch(SLIM_DESCRIPTIONS.Agent, /do not wait this turn/);
});
