import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  SERVER_COMPACTION_DETAILS_SOURCE,
  findUnprojectedServerCompaction,
  projectServerCompaction,
  serverCompactionRejection,
  serverCompactionResult,
} from "../../src/server-compaction-projection.mjs";
import { installServerCompaction } from "../../src/extensions/server-compaction.mjs";

const { SessionManager } = await import(pathToFileURL(join(senpiDir, "dist", "core", "session-manager.js")).href);

const anthropic = (id) => ({ provider: "anthropic", id, api: "anthropic-messages" });

function compactionBlock(content) {
  return { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content } };
}

function assistant(content, usage) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5-1",
    usage: usage ?? { input: 90_000, output: 500, cacheRead: 10_000, cacheWrite: 0, totalTokens: 100_500 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

/** `ctx` 흉내: 실제 SessionManager + `_executeCompaction` 의 precomputed 경로만 재현. */
function fakeContext(sessionManager, model = anthropic("claude-fable-5-1")) {
  const applied = [];
  return {
    model,
    sessionManager,
    applied,
    async applyCompaction(precomputed, options) {
      applied.push({ precomputed, options });
      sessionManager.appendCompaction(precomputed.summary, precomputed.firstKeptEntryId, precomputed.tokensBefore, precomputed.details, true, precomputed.usage);
      return { applied: true, reason: "ok" };
    },
  };
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    async emit(name, event, ctx) {
      return handlers.get(name)?.(event, ctx);
    },
  };
}

test("auto compaction is rejected with external-owner only for server-compaction models", () => {
  for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
    for (const reason of ["threshold", "overflow", "pre_prompt"]) {
      const result = serverCompactionRejection(anthropic(id), reason);
      assert.equal(result?.cancel, true, `${id}/${reason}`);
      assert.equal(result.rejectionCause, "external-owner");
      assert.match(result.reason, /Anthropic server compaction/);
    }
    // 투영 자체(extension) 와 사용자의 수동 /compact 는 통과해야 한다.
    assert.equal(serverCompactionRejection(anthropic(id), "extension"), undefined, `${id}/extension`);
    assert.equal(serverCompactionRejection(anthropic(id), "manual"), undefined, `${id}/manual`);
  }
  for (const model of [
    anthropic("claude-haiku-4-5"),
    { provider: "openai-codex", id: "gpt-5.6" },
    { provider: "xai", id: "grok-4" },
    { provider: "cursor", id: "claude-opus-5" },
    undefined,
  ]) {
    for (const reason of ["threshold", "overflow", "pre_prompt", "manual"]) {
      assert.equal(serverCompactionRejection(model, reason), undefined, `${model?.provider}/${model?.id}/${reason}`);
    }
  }
});

test("session_before_compact handler mirrors the pure decision through the extension surface", async () => {
  const pi = fakePi();
  installServerCompaction(pi);
  const blocked = await pi.emit("session_before_compact", { reason: "threshold" }, { model: anthropic("claude-opus-5") });
  assert.deepEqual(blocked, { cancel: true, rejectionCause: "external-owner", reason: "Anthropic server compaction owns compaction for this session" });
  assert.equal(await pi.emit("session_before_compact", { reason: "threshold" }, { model: anthropic("claude-haiku-4-5") }), undefined);
  assert.equal(await pi.emit("session_before_compact", { reason: "extension" }, { model: anthropic("claude-opus-5") }), undefined);
});

test("projection appends exactly one CompactionEntry with the server summary and the assistant entry as firstKept", async () => {
  const sm = SessionManager.inMemory("/tmp/rubato-server-compaction");
  sm.appendMessage(user("first"));
  sm.appendMessage(assistant([{ type: "text", text: "old answer" }]));
  sm.appendMessage(user("second"));
  const assistantId = sm.appendMessage(assistant([compactionBlock("SERVER SUMMARY"), { type: "text", text: "new answer" }]));

  const ctx = fakeContext(sm);
  const first = await projectServerCompaction(ctx);
  assert.deepEqual(first, { status: "applied", entryId: assistantId });
  assert.equal(ctx.applied.length, 1);
  assert.deepEqual(ctx.applied[0].precomputed, {
    summary: "SERVER SUMMARY",
    firstKeptEntryId: assistantId,
    tokensBefore: 100_500,
    details: { source: SERVER_COMPACTION_DETAILS_SOURCE, assistantEntryId: assistantId },
  });
  assert.equal(ctx.applied[0].options.reason, "extension");

  const compactions = sm.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].summary, "SERVER SUMMARY");
  assert.equal(compactions[0].firstKeptEntryId, assistantId);

  // 같은 블록으로 두 번 투영되지 않는다 — 후속 turn_end 에서도, 새 메시지가 붙어도.
  assert.deepEqual(await projectServerCompaction(ctx), { status: "none" });
  sm.appendMessage(user("third"));
  sm.appendMessage(assistant([{ type: "text", text: "no block" }]));
  assert.deepEqual(await projectServerCompaction(ctx), { status: "none" });
  assert.equal(sm.getBranch().filter((entry) => entry.type === "compaction").length, 1);
});

test("buildSessionContext after projection is [summary, assistant with block, later entries] and nothing earlier", async () => {
  const sm = SessionManager.inMemory("/tmp/rubato-server-compaction");
  sm.appendMessage(user("first"));
  sm.appendMessage(assistant([{ type: "text", text: "old answer" }]));
  sm.appendMessage(user("second"));
  const content = [compactionBlock("SERVER SUMMARY"), { type: "text", text: "new answer" }];
  sm.appendMessage(assistant(content));
  await projectServerCompaction(fakeContext(sm));
  sm.appendMessage(user("after"));

  const { messages } = sm.buildSessionContext();
  assert.deepEqual(
    messages.map((message) => message.role),
    ["compactionSummary", "assistant", "user"],
  );
  assert.equal(messages[0].summary, "SERVER SUMMARY");
  // Anthropic 재전송용 native 블록은 assistant 메시지에 그대로 남는다.
  assert.deepEqual(messages[1].content, content);
  assert.equal(messages[2].content[0].text, "after");
  assert.ok(!messages.some((message) => message.role === "user" && message.content?.[0]?.text === "first"));
});

test("null server summary produces no entry and only a diagnostic (once per entry)", async () => {
  const sm = SessionManager.inMemory("/tmp/rubato-server-compaction");
  sm.appendMessage(user("first"));
  const id = sm.appendMessage(assistant([compactionBlock(null), { type: "text", text: "answer" }]));
  const ctx = fakeContext(sm);

  const pi = fakePi();
  const diagnostics = [];
  installServerCompaction(pi, { onDiagnostic: (outcome) => diagnostics.push(outcome) });
  await pi.emit("turn_end", { message: {}, toolResults: [] }, ctx);
  await pi.emit("turn_end", { message: {}, toolResults: [] }, ctx);

  assert.equal(ctx.applied.length, 0);
  assert.equal(sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(diagnostics, [{ status: "summary-null", entryId: id }]);
  assert.equal(findUnprojectedServerCompaction(sm.getBranch())?.summary, undefined);
});

test("turn_end without any compaction block leaves the session untouched", async () => {
  const sm = SessionManager.inMemory("/tmp/rubato-server-compaction");
  sm.appendMessage(user("first"));
  sm.appendMessage(assistant([{ type: "text", text: "plain" }]));
  const ctx = fakeContext(sm);
  const pi = fakePi();
  installServerCompaction(pi);
  await pi.emit("turn_end", { message: {}, toolResults: [] }, ctx);
  assert.equal(ctx.applied.length, 0);
  assert.equal(sm.getBranch().length, 2);
});

test("a prior client compaction after the block stops re-projection; tokensBefore falls back to summed usage", () => {
  const branch = [
    { type: "message", id: "a", message: assistant([compactionBlock("S")], { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 }) },
    { type: "compaction", id: "c", summary: "client", firstKeptEntryId: "a", tokensBefore: 1 },
    { type: "message", id: "u", message: user("x") },
  ];
  assert.equal(findUnprojectedServerCompaction(branch), undefined);
  const found = findUnprojectedServerCompaction(branch.slice(0, 1));
  assert.deepEqual(found, { entryId: "a", summary: "S" });
  assert.equal(serverCompactionResult(branch, found).tokensBefore, 16);
});

test("tokensBefore prefers the compaction iteration and sums its uncached + cached input", () => {
  // 실측: 압축 iteration 의 input_tokens 는 캐시 밖 부분(45)뿐이고 컨텍스트 대부분이 cache_creation(181854) 에 있다.
  const usage = {
    input: 40, output: 300, cacheRead: 0, cacheWrite: 2_000, totalTokens: 2_340,
    compaction: { input: 45, output: 1_200, cacheRead: 0, cacheWrite: 181_854 },
  };
  const branch = [{ type: "message", id: "a", message: assistant([compactionBlock("S")], usage) }];
  const found = findUnprojectedServerCompaction(branch);
  assert.equal(serverCompactionResult(branch, found).tokensBefore, 181_899);
});

// 실제 AgentSession.applyCompaction(precomputed) 경로: prepareCompaction/LLM 없이
// stale/overflow 검사 → appendCompaction → agent.state.messages 재구성까지 확인한다.
test("real AgentSession.applyCompaction projects the server summary and rebuilds agent messages", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createAgentSession, createExtensionRuntime, ModelRegistry, ModelRuntime, SettingsManager } = await import(
    pathToFileURL(join(senpiDir, "dist", "index.js")).href
  );
  const root = mkdtempSync(join(tmpdir(), "rubato-server-compaction-"));
  const modelRuntime = ModelRuntime.createSync();
  const modelRegistry = new ModelRegistry(modelRuntime);
  const model = modelRegistry.find("anthropic", "claude-opus-5");
  assert.ok(model, "pinned catalog has claude-opus-5");
  const sm = SessionManager.inMemory(root);
  sm.appendMessage(user("first"));
  sm.appendMessage(assistant([{ type: "text", text: "old" }]));
  sm.appendMessage(user("second"));
  const content = [compactionBlock("SERVER SUMMARY"), { type: "text", text: "new" }];
  const assistantId = sm.appendMessage(assistant(content));
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    model,
    modelRuntime,
    modelRegistry,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: sm,
    resourceLoader,
    tools: [],
    customTools: [],
    scopedModels: [],
    favoriteModels: [],
  });
  try {
    const events = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") events.push({ reason: event.reason, accepted: event.accepted, errorMessage: event.errorMessage });
    });
    const ctx = { model: session.model, sessionManager: sm, applyCompaction: (precomputed, options) => session.applyCompaction(precomputed, options) };
    assert.deepEqual(await projectServerCompaction(ctx), { status: "applied", entryId: assistantId });
    assert.deepEqual(events, [{ reason: "extension", accepted: true, errorMessage: undefined }]);
    assert.deepEqual(session.agent.state.messages.map((message) => message.role), ["compactionSummary", "assistant"]);
    assert.equal(session.agent.state.messages[0].summary, "SERVER SUMMARY");
    assert.deepEqual(session.agent.state.messages[1].content, content);
    const compactions = sm.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].firstKeptEntryId, assistantId);
    assert.equal(compactions[0].details.source, SERVER_COMPACTION_DETAILS_SOURCE);
    assert.deepEqual(await projectServerCompaction(ctx), { status: "none" });
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
