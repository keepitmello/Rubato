import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRolePromptExtensionFactories, ROLE_PROMPT_FACTORY_NAME } from "./role-prompt.mjs";
import { promptForAgentStart, replaceSystemPrompt } from "../../../rubato-pi/src/system-prompt.mjs";
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
    owner: /# Teammate/,
    verifier: /# Teammate/,
    agent: /# Assigned agent/,
  };
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const env = { RUBATO_PI_ROLE: role, RUBATO_ROLE_PROMPT_MODULE: promptHref, RUBATO_ROLE_CONTRACT_MODULE: roleHref };
    assert.equal(resolveRole({ env }), role);
    const senpi = replaceSystemPrompt("", role, { env, argv: process.argv });
    assert.match(senpi, /# Working agreement/);
    assert.match(senpi, headings[role]);
    const handlers = {};
    const pi = { on(name, fn) { handlers[name] = fn; } };
    await createRolePromptExtensionFactories({ env })[0].factory(pi);
    const result = await handlers.system_prompt(
      { systemPrompt: "" },
      { model: { id: "grok-4.7", provider: "xai", name: "Grok 4.7" } },
    );
    const dump = result.systemPrompt;
    assert.match(dump, /# Working agreement/);
    assert.match(dump, headings[role]);
    assert.match(dump, /The following skills provide specialized instructions|available_skills/);
    assert.equal(dump, promptForAgentStart({ systemPrompt: "" }, { model: { id: "grok-4.7", provider: "xai", name: "Grok 4.7" } }, role, { env, argv: process.argv }));
    assert.match(senpi, headings[role]);
  }
});

test("the skills listing stays pinned to the session until /reload", async () => {
  // The listing sits ahead of the whole history; a description edited on disk must not
  // rewrite the cached prefix mid-session or on restart. /reload takes the new listing.
  const env = { RUBATO_PI_ROLE: "lead", RUBATO_ROLE_PROMPT_MODULE: promptHref, RUBATO_ROLE_CONTRACT_MODULE: roleHref };
  const listing = (description) =>
    `The following skills provide specialized instructions for specific tasks.\n<available_skills>\n  <skill><name>demo</name><description>${description}</description></skill>\n</available_skills>`;
  const branch = [];
  const ctx = {
    model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
    sessionManager: { getSessionId: () => "session-pin", getBranch: () => branch },
  };
  const boot = async () => {
    const handlers = {};
    const pi = {
      on(name, fn) { handlers[name] = fn; },
      appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    };
    await createRolePromptExtensionFactories({ env })[0].factory(pi);
    return handlers;
  };
  const compose = async (handlers, description) =>
    (await handlers.system_prompt({ systemPrompt: `BASE\n\n${listing(description)}` }, ctx)).systemPrompt;

  let handlers = await boot();
  await handlers.session_start({ reason: "startup" }, ctx);
  assert.match(await compose(handlers, "first"), /first/);
  assert.match(await compose(handlers, "edited on disk"), /first/);
  assert.doesNotMatch(await compose(handlers, "edited on disk"), /edited on disk/);

  handlers = await boot();
  await handlers.session_start({ reason: "resume" }, ctx);
  assert.match(await compose(handlers, "edited on disk"), /first/, "a restart keeps the pinned listing");

  await handlers.session_start({ reason: "reload" }, ctx);
  assert.match(await compose(handlers, "edited on disk"), /edited on disk/);
  assert.match(await compose(handlers, "later edit"), /edited on disk/);
});

test("contributions made before the role prompt survive its rebuild", async () => {
  // context-notes guidance, project rules and the todo section are appended by handlers that
  // run before the role prompt; the rebuild used to drop them.
  const env = { RUBATO_PI_ROLE: "lead", RUBATO_ROLE_PROMPT_MODULE: promptHref, RUBATO_ROLE_CONTRACT_MODULE: roleHref };
  const handlers = {};
  await createRolePromptExtensionFactories({ env })[0].factory({ on(name, fn) { handlers[name] = fn; } });
  const base = "You are an expert coding assistant operating inside pi.\n\n<cwd>\n/tmp/x\n</cwd>";
  const result = await handlers.system_prompt(
    { systemPrompt: `${base}\n<Task_Management>todo</Task_Management>\n\nEARLIER_GUIDANCE`, basePrompt: base },
    { model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" } },
  );
  assert.match(result.systemPrompt, /# Working agreement/);
  assert.match(result.systemPrompt, /<Task_Management>todo<\/Task_Management>/);
  assert.match(result.systemPrompt, /EARLIER_GUIDANCE$/);
  assert.equal(result.systemPrompt.match(/Current working directory: \/tmp\/x/g)?.length, 1);
  assert.doesNotMatch(result.systemPrompt, /operating inside pi/);
});
