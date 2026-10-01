import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("the role prompt file stays pinned to the session until /reload", async (t) => {
  // The role prompt sits ahead of the whole history; rebuilding .build on disk must reach new
  // sessions only, not rewrite the cached prefix of a running or resumed one.
  const dir = mkdtempSync(join(tmpdir(), "rubato-role-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".build"));
  const write = (text) => writeFileSync(join(dir, ".build", "lead.pi.md"), `# Working agreement\n\n${text}\n\n# Lead\n`);
  const env = {
    RUBATO_PI_ROLE: "lead",
    RUBATO_PROMPTS_DIR: dir,
    RUBATO_ROLE_PROMPT_MODULE: promptHref,
    RUBATO_ROLE_CONTRACT_MODULE: roleHref,
  };
  const branches = new Map();
  const ctxFor = (id) => {
    if (!branches.has(id)) branches.set(id, []);
    return {
      model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
      sessionManager: { getSessionId: () => id, getBranch: () => branches.get(id) },
    };
  };
  let current = "session-a";
  const boot = async () => {
    const handlers = {};
    const pi = {
      on(name, fn) { handlers[name] = fn; },
      appendEntry(customType, data) { branches.get(current).push({ type: "custom", customType, data }); },
    };
    await createRolePromptExtensionFactories({ env })[0].factory(pi);
    return handlers;
  };
  const compose = async (handlers, id) => {
    current = id;
    return (await handlers.system_prompt({ systemPrompt: "" }, ctxFor(id))).systemPrompt;
  };

  write("first version");
  let handlers = await boot();
  await handlers.session_start({ reason: "startup" }, ctxFor("session-a"));
  assert.match(await compose(handlers, "session-a"), /first version/);

  write("second version");
  assert.match(await compose(handlers, "session-a"), /first version/, "a running session keeps its prompt");
  assert.doesNotMatch(await compose(handlers, "session-a"), /second version/);

  handlers = await boot();
  await handlers.session_start({ reason: "resume" }, ctxFor("session-a"));
  assert.match(await compose(handlers, "session-a"), /first version/, "a restart keeps the pinned prompt");

  await handlers.session_start({ reason: "new" }, ctxFor("session-b"));
  assert.match(await compose(handlers, "session-b"), /second version/, "a new session takes the current file");

  await handlers.session_start({ reason: "reload" }, ctxFor("session-a"));
  assert.match(await compose(handlers, "session-a"), /second version/, "/reload takes the current file");
  write("third version");
  assert.match(await compose(handlers, "session-a"), /second version/);
});

test("project instructions and rules stay pinned to the session until /reload", async () => {
  // CLAUDE.md is read when the engine loads and static rules on every request; both sit ahead of
  // the history, so an edit must reach new sessions only.
  const env = { RUBATO_PI_ROLE: "lead", RUBATO_ROLE_PROMPT_MODULE: promptHref, RUBATO_ROLE_CONTRACT_MODULE: roleHref };
  const branches = new Map();
  let current = "session-a";
  const ctxFor = (id) => {
    if (!branches.has(id)) branches.set(id, []);
    return {
      model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
      sessionManager: { getSessionId: () => id, getBranch: () => branches.get(id) },
    };
  };
  const handlers = {};
  await createRolePromptExtensionFactories({ env })[0].factory({
    on(name, fn) { handlers[name] = fn; },
    appendEntry(customType, data) { branches.get(current).push({ type: "custom", customType, data }); },
  });
  const base = (claude) => claude === undefined
    ? "<cwd>\n/tmp/x\n</cwd>"
    : `<project_context>\n${claude}\n</project_context>\n\n<cwd>\n/tmp/x\n</cwd>`;
  const rules = (text) => `\n\n<!--senpi:project-rules:1:start-->\n<project_rules>\n${text}\n</project_rules>\n<!--senpi:project-rules:1:end-->`;
  const compose = async (id, claude, rule) => {
    current = id;
    const basePrompt = base(claude);
    const result = await handlers.system_prompt({ systemPrompt: basePrompt + (rule === undefined ? "" : rules(rule)), basePrompt }, ctxFor(id));
    return result.systemPrompt;
  };

  await handlers.session_start({ reason: "startup" }, ctxFor("session-a"));
  const first = await compose("session-a", "claude one", "rule one");
  assert.match(first, /claude one/);
  assert.match(first, /rule one/);
  assert.equal(await compose("session-a", "claude two", "rule two"), first, "edits do not reach a running session");

  await handlers.session_start({ reason: "resume" }, ctxFor("session-a"));
  assert.equal(await compose("session-a", "claude two", "rule two"), first, "a restart keeps the pinned files");

  await handlers.session_start({ reason: "new" }, ctxFor("session-b"));
  const fresh = await compose("session-b", undefined, undefined);
  assert.doesNotMatch(fresh, /project_context|project_rules/);
  assert.equal(await compose("session-b", "claude added", "rule added"), fresh, "a file added mid-session waits for a new session");

  await handlers.session_start({ reason: "reload" }, ctxFor("session-a"));
  const reloaded = await compose("session-a", "claude two", "rule two");
  assert.match(reloaded, /claude two/);
  assert.match(reloaded, /rule two/);
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
