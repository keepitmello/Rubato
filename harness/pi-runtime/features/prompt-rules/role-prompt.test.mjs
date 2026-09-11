import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRolePromptExtensionFactories, ROLE_PROMPT_FACTORY_NAME } from "./role-prompt.mjs";
import { promptForAgentStart, replaceSystemPrompt, TOOL_GUIDELINES } from "../../../rubato-pi/src/system-prompt.mjs";
import { resolveRole } from "../../../rubato-pi/src/role-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const promptHref = pathToFileURL(resolve(here, "../../../rubato-pi/src/system-prompt.mjs")).href;
const roleHref = pathToFileURL(resolve(here, "../../../rubato-pi/src/role-contract.mjs")).href;

test("rubato-role-prompt factory name is toggleable", () => {
  const factories = createRolePromptExtensionFactories({ env: {} });
  assert.deepEqual(factories.map((entry) => entry.name), [ROLE_PROMPT_FACTORY_NAME]);
});

test("role prompt dump matches senpi replaceSystemPrompt for lead/owner/verifier/agent", async (t) => {
  const headings = {
    lead: /# Lead/,
    owner: /# Workstream owner/,
    verifier: /# Workstream owner/,
    agent: /# Assigned agent/,
  };
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const env = { RUBATO_PI_ROLE: role, RUBATO_ROLE_PROMPT_MODULE: promptHref, RUBATO_ROLE_CONTRACT_MODULE: roleHref };
    assert.equal(resolveRole({ env }), role);
    const senpi = replaceSystemPrompt("", role, { env, argv: process.argv });
    assert.match(senpi, /# Working agreement/);
    assert.match(senpi, /## Tool Guidelines/);
    assert.equal(senpi.includes(TOOL_GUIDELINES.slice(0, 20)), true);
    assert.match(senpi, headings[role]);
    const handlers = {};
    const pi = { on(name, fn) { handlers[name] = fn; } };
    await createRolePromptExtensionFactories({ env })[0].factory(pi);
    const result = await handlers.before_agent_start(
      { systemPrompt: "" },
      { model: { id: "grok-4.6", provider: "xai", name: "Grok 4.6" } },
    );
    const dump = result.systemPrompt;
    assert.match(dump, /# Working agreement/);
    assert.match(dump, /## Tool Guidelines/);
    assert.match(dump, headings[role]);
    assert.match(dump, /The following skills provide specialized instructions|available_skills/);
    assert.equal(dump, promptForAgentStart({ systemPrompt: "" }, { model: { id: "grok-4.6", provider: "xai", name: "Grok 4.6" } }, role, { env, argv: process.argv }));
    assert.match(senpi, headings[role]);
  }
});
