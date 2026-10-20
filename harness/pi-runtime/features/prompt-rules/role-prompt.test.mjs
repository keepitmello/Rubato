import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPANION_ROLE as ROLE_PROMPT_COMPANION_ROLE, createRolePromptExtensionFactories, openingTurnMessage, ROLE_PROMPT_FACTORY_NAME, SERVER_COMPACTION_BLOCK, SYSTEM_PROMPT_REPLACEMENT_ENTRY_TYPE } from "./role-prompt.mjs";
import { isAnthropicCompactionBlock } from "../compaction/anthropic-server-compaction.mjs";
import { SYSTEM_PROMPT_REPLACEMENT_ENTRY } from "../session-prompt/patches.mjs";
import { promptForAgentStart, replaceSystemPrompt } from "../../../rubato-pi/src/system-prompt.mjs";
import { resolveRole } from "../../../rubato-pi/src/role-contract.mjs";
import { COMPANION_ROLE, PIECES, writePiece } from "../../../companion/companion.mjs";

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

test("the replacement entry type matches the session-prompt engine patch", () => {
  assert.equal(SYSTEM_PROMPT_REPLACEMENT_ENTRY_TYPE, SYSTEM_PROMPT_REPLACEMENT_ENTRY);
});

test("the opening turn leads every request of a new session and stays pinned", async (t) => {
  // It sits ahead of the whole history, so it must never move or change under a cached prefix:
  // edits on disk reach new sessions only, and a session that already has replies never gets it.
  const dir = mkdtempSync(join(tmpdir(), "rubato-opening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (text) => writeFileSync(join(dir, "opening-turn.pi.md"), `${text}\n`);
  const env = {
    RUBATO_PI_ROLE: "lead",
    RUBATO_PROMPTS_DIR: dir,
    RUBATO_ROLE_PROMPT_MODULE: promptHref,
    RUBATO_ROLE_CONTRACT_MODULE: roleHref,
  };
  const branches = new Map();
  let current = "session-a";
  const ctxFor = (id) => {
    if (!branches.has(id)) branches.set(id, []);
    return { sessionManager: { getSessionId: () => id, getBranch: () => branches.get(id) } };
  };
  const boot = async (bootEnv = env) => {
    const handlers = {};
    await createRolePromptExtensionFactories({ env: bootEnv })[0].factory({
      on(name, fn) { handlers[name] = fn; },
      appendEntry(customType, data) { branches.get(current).push({ type: "custom", customType, data }); },
    });
    return handlers;
  };
  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
  const reply = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 };
  const request = async (handlers, id, messages) => {
    current = id;
    return (await handlers.context({ type: "context", messages }, ctxFor(id)))?.messages ?? messages;
  };

  write("I am Lea. First words.");
  let handlers = await boot();
  const first = await request(handlers, "session-a", [user]);
  assert.deepEqual(first[0], openingTurnMessage("I am Lea. First words."));
  assert.equal(first[1], user);

  write("I am Lea. Edited words.");
  const later = await request(handlers, "session-a", [user, reply, user]);
  assert.deepEqual(later[0], first[0], "a running session keeps its opening turn");
  assert.equal(later.length, 4);

  handlers = await boot();
  assert.deepEqual((await request(handlers, "session-a", [user, reply]))[0], first[0], "a restart keeps it");

  const fresh = await request(handlers, "session-b", [user]);
  assert.equal(fresh[0].content[0].text, "I am Lea. Edited words.", "a new session takes the current file");

  const existing = await request(handlers, "session-c", [user, reply]);
  assert.deepEqual(existing, [user, reply], "a session that already has replies is left as it was");
  assert.deepEqual(await request(handlers, "session-c", [user]), [user]);

  const custom = await boot({ ...env, RUBATO_SYSTEM_PROMPT_FILE: join(dir, "own.md") });
  assert.deepEqual(await request(custom, "session-d", [user]), [user], "a custom prompt file gets no opening turn");

  branches.set("session-e", [{ type: "custom", customType: SYSTEM_PROMPT_REPLACEMENT_ENTRY, data: { value: "Own prompt." } }]);
  assert.deepEqual(await request(handlers, "session-e", [user]), [user], "a session opened with its own whole prompt gets no opening turn");
});

/** Segno's conversation with its pieces in a sandbox; `compose` is one request's system prompt. */
async function companionSession(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-companion-prompt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prompts = join(dir, "prompts");
  const defaultsDir = join(prompts, "companion");
  mkdirSync(defaultsDir, { recursive: true });
  for (const { id } of PIECES) writeFileSync(join(defaultsDir, `${id}.pi.md`), `default ${id}\n`);
  writeFileSync(join(prompts, "opening-turn.pi.md"), "I am Lea.\n");
  const env = {
    RUBATO_PI_ROLE: COMPANION_ROLE,
    RUBATO_PROMPTS_DIR: prompts,
    RUBATO_COMPANION_HOME: join(dir, "home"),
    RUBATO_ROLE_PROMPT_MODULE: promptHref,
    RUBATO_ROLE_CONTRACT_MODULE: roleHref,
  };
  const branch = [];
  const ctx = {
    model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
    sessionManager: { getSessionId: () => "segno", getBranch: () => branch },
  };
  const handlers = {};
  await createRolePromptExtensionFactories({ env })[0].factory({
    on(name, fn) { handlers[name] = fn; },
    appendEntry(customType, data) { branch.push({ type: "custom", id: `e${branch.length}`, customType, data }); },
  });
  return {
    env, branch, ctx, handlers, defaultsDir,
    compose: async () => (await handlers.system_prompt({ systemPrompt: "" }, ctx)).systemPrompt,
    pinned: () => branch.filter((entry) => entry.customType === "rubato.role-prompt").length,
    editDefault: (id, text) => writeFileSync(join(defaultsDir, `${id}.pi.md`), text),
    editPersonal: (id, text) => writePiece(id, text, { defaultsDir, env }),
    say: (role, content) => branch.push({ type: "message", id: `e${branch.length}`, message: { role, content, timestamp: branch.length } }),
    newWindow: () => branch.push({ type: "compaction", id: `e${branch.length}`, summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
    serverCompaction: (summary = "what came before") => branch.push({ type: "message", id: `e${branch.length}`, message: { role: "assistant",
      content: [{ type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: summary } }, { type: "text", text: "ok" }], timestamp: branch.length } }),
  };
}

test("the companion's prompt is its pieces, the person's versions first", async (t) => {
  const s = await companionSession(t);
  const first = await s.compose();
  assert.ok(first.startsWith(PIECES.filter(({ id }) => id !== "coda").map(({ id }) => `default ${id}`).join("\n\n")),
    "the pieces in order, ahead of everything else: Roo's build.sh order, the resident memory last");
  assert.ok(first.endsWith("\n\n---\n\ndefault coda"), "the closing piece is the very end, after a rule (Roo build.sh coda)");
  assert.doesNotMatch(first, /segno:coda/);
  assert.match(first, /Role: companion/);
  assert.doesNotMatch(first, /# Working agreement/);
  assert.equal(await s.compose(), first);
  assert.equal(s.pinned(), 1, "an unchanged composition is not written again");
  assert.throws(() => s.editPersonal("tools", "other tools"), /no personal version/);

  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
  assert.deepEqual((await s.handlers.context({ type: "context", messages: [user] }, s.ctx))?.messages ?? [user], [user],
    "the companion's preamble is its own, so the leads' opening turn does not answer it");
});

test("the companion's closing piece stays last even after what other handlers appended", async (t) => {
  const s = await companionSession(t);
  const base = "You are an expert coding assistant operating inside pi.\n\n<cwd>\n/tmp/x\n</cwd>";
  const result = await s.handlers.system_prompt({ systemPrompt: `${base}\n\nEARLIER_GUIDANCE`, basePrompt: base }, s.ctx);
  assert.match(result.systemPrompt, /EARLIER_GUIDANCE/);
  assert.ok(result.systemPrompt.endsWith("EARLIER_GUIDANCE\n\n---\n\ndefault coda"));
  assert.equal(result.systemPrompt.match(/default coda/g).length, 1);
});

test("the resident memory piece is read from Segno's memory folder, where the dream keeps it", async (t) => {
  const s = await companionSession(t);
  mkdirSync(join(s.env.RUBATO_COMPANION_HOME, "memory"), { recursive: true });
  writeFileSync(join(s.env.RUBATO_COMPANION_HOME, "memory", "MEMORY.md"), "## 살아있는 약속\n- 아침엔 커피");
  const prompt = await s.compose();
  assert.match(prompt, /default tools\n\n## 살아있는 약속\n- 아침엔 커피/);
  assert.doesNotMatch(prompt, /default memory/);
});

test("a piece edit waits for the companion's next new window; until then every request is the same", async (t) => {
  const s = await companionSession(t);
  const first = await s.compose();
  s.say("user", "hi"); s.say("assistant", [{ type: "text", text: "hey" }]);
  s.editDefault("companion", "default companion\n\n## Sleep\nnew lines\n");
  s.editPersonal("soul", "my own soul");
  assert.equal(await s.compose(), first, "an update's piece and a Settings edit do not touch the cached prefix");
  assert.equal(s.pinned(), 1);

  s.newWindow();
  const after = await s.compose();
  assert.match(after, /## Sleep\nnew lines/);
  assert.match(after, /my own soul/);
  assert.equal(s.pinned(), 2);
  assert.equal(await s.compose(), after, "and it holds from there");
  assert.equal(s.pinned(), 2);
});

test("a server compaction (compact_context, or the safety line) also takes the pieces as they are then", async (t) => {
  const s = await companionSession(t);
  const first = await s.compose();
  s.editPersonal("soul", "my own soul");
  s.serverCompaction(null);
  s.branch.at(-1).message.content[0].raw.content = null;
  assert.equal(await s.compose(), first, "a compaction the server failed to summarize rewrote nothing");
  s.serverCompaction();
  assert.match(await s.compose(), /my own soul/);
  assert.equal(s.pinned(), 2);
});

test("a companion pinned before this rule takes its pieces once, then holds", async (t) => {
  const s = await companionSession(t);
  s.branch.push({ type: "custom", id: "old", customType: "rubato.role-prompt", data: { value: "an old prompt" } });
  const now = await s.compose();
  assert.doesNotMatch(now, /an old prompt/);
  assert.match(now, /default soul/);
  s.editPersonal("soul", "my own soul");
  assert.equal(await s.compose(), now);
  assert.equal(s.pinned(), 2);
});

test("a restart keeps the companion's pin: it is read from the session, not from disk", async (t) => {
  const s = await companionSession(t);
  const first = await s.compose();
  s.editPersonal("soul", "my own soul");
  const handlers = {};
  await createRolePromptExtensionFactories({ env: s.env })[0].factory({
    on(name, fn) { handlers[name] = fn; },
    appendEntry(customType, data) { s.branch.push({ type: "custom", id: `e${s.branch.length}`, customType, data }); },
  });
  assert.equal((await handlers.system_prompt({ systemPrompt: "" }, s.ctx)).systemPrompt, first);
});

test("the role prompt reads a server compaction the way the compaction feature writes it", () => {
  const block = { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "x" } };
  assert.equal(isAnthropicCompactionBlock(block), true);
  assert.deepEqual({ type: block.type, subtype: block.subtype }, { ...SERVER_COMPACTION_BLOCK });
});

test("the role prompt names the companion's role the way harness/companion does", () => {
  assert.equal(ROLE_PROMPT_COMPANION_ROLE, COMPANION_ROLE);
});
