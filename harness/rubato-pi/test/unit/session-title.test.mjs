import test from "node:test";
import assert from "node:assert/strict";
import {
  TITLE_ENTRY,
  buildTitlePrompt,
  isTitleLocked,
  lastAutoTitle,
  parseTitle,
  sanitizeTitle,
  shouldRetitle,
  tabTitle,
  userTextsFromEntries,
} from "../../src/session-title.mjs";
import {
  installSessionTitle,
  paintTabTitle,
  pickTitleModel,
  refreshSessionTitle,
  titleFromResponse,
} from "../../src/extensions/session-title.mjs";

function userEntry(text) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

test("user texts skip slash commands and keep the latest ones", () => {
  const texts = userTextsFromEntries(
    [
      userEntry("/name ignore me"),
      userEntry("first prompt about Pi"),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      userEntry("now title by topic instead"),
    ],
    { limit: 2 },
  );
  assert.deepEqual(texts, ["first prompt about Pi", "now title by topic instead"]);
});

test("parseTitle reads the tag and drops none", () => {
  assert.equal(parseTitle("<title>Fix session tab title</title>"), "Fix session tab title");
  assert.equal(parseTitle("<title>none</title>"), undefined);
  assert.equal(parseTitle("no tags here"), undefined);
  assert.equal(sanitizeTitle('  "Hello world!"  '), "Hello world");
});

test("shouldRetitle follows the topic until /name locks it", () => {
  assert.equal(shouldRetitle({ current: undefined, proposed: "Topic title" }), true);
  assert.equal(shouldRetitle({ current: "Fix rubato-pi session name", proposed: "Topic titles for tabs" }), true);
  assert.equal(shouldRetitle({ current: "Topic titles for tabs", proposed: "Retitle by conversation topic" }), true);
  assert.equal(shouldRetitle({ current: "manual name", proposed: "Topic titles for tabs", locked: true }), false);
  assert.equal(shouldRetitle({ current: "same", proposed: "same" }), false);
});

test("tab title is the bare name, falling back to the folder", () => {
  assert.equal(tabTitle(undefined, "agent-taskforce"), "agent-taskforce");
  assert.equal(tabTitle("Tab titles", "agent-taskforce"), "Tab titles");
  assert.equal(tabTitle(undefined, undefined), "");
  assert.equal(buildTitlePrompt(["a", "b"]), "Recent user messages:\n1. a\n2. b");
  assert.equal(lastAutoTitle([{ type: "custom", customType: TITLE_ENTRY, data: { name: "kept" } }]), "kept");
  assert.equal(
    lastAutoTitle([
      { type: "custom", customType: TITLE_ENTRY, data: { name: "kept" } },
      { type: "custom", customType: TITLE_ENTRY, data: { locked: true } },
    ]),
    "kept",
  );
  assert.equal(isTitleLocked([{ type: "custom", customType: TITLE_ENTRY, data: { name: "kept" } }]), false);
  assert.equal(isTitleLocked([{ type: "custom", customType: TITLE_ENTRY, data: { locked: true } }]), true);
});

test("installSessionTitle paints an ASCII tab on session_start", () => {
  const titles = [];
  const pi = {
    on(event, handler) {
      this.handlers ??= {};
      this.handlers[event] = handler;
    },
    getSessionName: () => undefined,
    setSessionName() {},
    appendEntry() {},
  };
  installSessionTitle(pi);
  pi.handlers.session_start(
    { reason: "new" },
    {
      cwd: "/Users/wy/Github-repos/agent-taskforce",
      ui: { setTitle: (title) => titles.push(title) },
      sessionManager: { getEntries: () => [] },
    },
  );
  assert.deepEqual(titles, ["agent-taskforce"]);
});

test("refreshSessionTitle names the topic and skips a later locked name", async () => {
  const names = [];
  const entries = [userEntry("터미널 세션 이름이 Pi로 나와"), userEntry("첫 문장 말고 주제로 지어줘")];
  const pi = {
    getSessionName: () => names.at(-1),
    setSessionName: (name) => names.push(name),
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
  };
  const ctx = {
    cwd: "/tmp/repo",
    ui: { setTitle() {} },
    model: { provider: "xai", id: "grok-4.6" },
    modelRegistry: {
      find: (provider, id) => ({ provider, id }),
      async complete() {
        return { content: [{ type: "text", text: "<title>Topic titles for tabs</title>" }] };
      },
    },
    sessionManager: { getEntries: () => entries },
  };
  const state = { lastAuto: undefined, locked: false };
  await refreshSessionTitle(pi, ctx, state);
  assert.deepEqual(names, ["Topic titles for tabs"]);
  assert.equal(state.lastAuto, "Topic titles for tabs");
  assert.equal(lastAutoTitle(entries), "Topic titles for tabs");

  state.locked = true;
  ctx.modelRegistry.complete = async () => ({ content: [{ type: "text", text: "<title>Should not apply</title>" }] });
  await refreshSessionTitle(pi, ctx, state);
  assert.deepEqual(names, ["Topic titles for tabs"]);
});

test("/name locks later auto titles and survives resume", () => {
  const titles = [];
  const entries = [];
  const handlers = {};
  const pi = {
    on(event, handler) {
      handlers[event] = handler;
    },
    getSessionName: () => "Fix rubato-pi session name",
    setSessionName() {},
    appendEntry(type, data) {
      entries.push({ type: "custom", customType: type, data });
    },
  };
  installSessionTitle(pi);
  handlers.session_start(
    { reason: "startup" },
    {
      cwd: "/tmp/repo",
      ui: { setTitle: (title) => titles.push(title) },
      sessionManager: { getEntries: () => entries },
    },
  );
  assert.equal(handlers.input({ text: "/name My tab" }).action, "continue");
  assert.equal(isTitleLocked(entries), true);
  handlers.session_info_changed({ name: "My tab" }, { cwd: "/tmp/repo", ui: { setTitle: (title) => titles.push(title) } });
  assert.ok(titles.includes("My tab"));

  const resumed = {};
  const again = {
    on(event, handler) {
      resumed[event] = handler;
    },
    getSessionName: () => "My tab",
    appendEntry() {},
  };
  installSessionTitle(again);
  let lockedRefresh = false;
  resumed.session_start(
    { reason: "resume" },
    {
      cwd: "/tmp/repo",
      ui: { setTitle() {} },
      sessionManager: { getEntries: () => entries },
    },
  );
  resumed.agent_settled?.(null, {
    sessionManager: { getEntries: () => [userEntry("should not retitle")] },
    modelRegistry: {
      find: () => ({ id: "haiku" }),
      complete: async () => {
        lockedRefresh = true;
        return { content: [{ type: "text", text: "<title>Nope</title>" }] };
      },
    },
  });
  assert.equal(lockedRefresh, false);
});

test("pickTitleModel prefers haiku and titleFromResponse reads complete() output", () => {
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  assert.equal(pickTitleModel({ find: () => haiku }, { id: "fallback" }), haiku);
  assert.equal(pickTitleModel({ find: () => undefined }, { id: "fallback" }).id, "fallback");
  assert.equal(titleFromResponse({ content: [{ type: "text", text: "<title>Ok</title>" }] }), "Ok");
  paintTabTitle({ cwd: "/tmp/repo", ui: { setTitle: (title) => assert.equal(title, "repo") } });
});
