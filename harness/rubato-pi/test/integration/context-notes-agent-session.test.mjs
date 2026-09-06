import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { senpiCliPath } from "../../src/launch.mjs";
import { launchEnv } from "../../src/brand.mjs";
import { noChangelogRegisterHref } from "../../src/no-changelog.mjs";
import { BOOTSTRAP_PREFIX, MODE_ENTRY, NOTE_ENTRY } from "../../src/context-notes/protocol.mjs";
import { startMockOpenAI } from "../helpers/mock-openai.mjs";

const enabled = process.env.RUBATO_TEST_CONTEXT_NOTES_ENGINE === "1";
const NOTE_TEXT = "GOAL checkpoint original-window";
const USER_TEXT = "Perform the notes experiment. Marker: ORIGINAL-REQUIREMENT";

function parseEntries(file) {
  if (!file) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function messageBlob(messages = []) {
  return JSON.stringify(messages);
}

function attachRpc(child) {
  const events = [];
  let buf = "";
  const waiters = [];
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      events.push(rec);
      if (rec.type === "extension_ui_request" && rec.method !== "confirm" && rec.id) {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: rec.id, cancelled: true })}\n`);
      }
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].match(rec)) {
          const waiter = waiters.splice(i, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(rec);
        }
      }
    }
  };
  child.stdout.on("data", onData);
  return {
    events,
    send(payload) { child.stdin.write(`${JSON.stringify(payload)}\n`); },
    wait(match, timeoutMs, label) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          const types = events.slice(0, 8).map((e) => e.type ?? e.command).join(",");
          reject(new Error(`timeout waiting for ${label ?? "event"}; saw ${types || "no events"}`));
        }, timeoutMs);
        const entry = { match, resolve, timer };
        waiters.push(entry);
      });
    },
  };
}

async function startHarness({ env = {}, script, models, extraArgs = [] } = {}) {
  const mock = await startMockOpenAI({
    onRequest: (body) => (script ? script(body, mock.requests.length - 1) : { type: "text", text: "ok" }),
  });
  const home = mkdtempSync(join(tmpdir(), "rubato-notes-as-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProjectTrust: "always",
    permissionPreset: "full-access",
    compaction: { enabled: true },
    defaultProvider: "mock",
    defaultModel: "stub",
  })}\n`);
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      mock: {
        baseUrl: mock.url,
        api: "openai-completions",
        apiKey: "dummy",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          { id: "stub", reasoning: false, contextWindow: 1000000, maxTokens: 256 },
          { id: "claude-fable-5-1", reasoning: false, contextWindow: 1000000, maxTokens: 256 },
        ],
      },
      "openai-codex": {
        baseUrl: mock.url,
        api: "openai-completions",
        apiKey: "dummy",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "gpt-6-astra", reasoning: false, contextWindow: 1000000, maxTokens: 256 }],
      },
      ...models,
    },
  })}\n`);
  let stderr = "";
  const child = spawn(process.execPath, [
    `--import=${noChangelogRegisterHref()}`,
    senpiCliPath(),
    "--mode", "rpc",
    "--no-context-files",
    "--no-prompt-templates",
    "--approve",
    "--permission-preset", "full-access",
    "--api-key", "dummy",
    "--model", "mock/stub",
    "-e", fileURLToPath(new URL("../helpers/context-notes-rpc-extension.mjs", import.meta.url)),
    ...extraArgs,
  ], {
    cwd,
    env: {
      ...launchEnv(process.env, agentDir),
      HOME: home,
      PATH: process.env.PATH,
      NODE_OPTIONS: "",
      CI: "1",
      RUBATO_NO_SPLASH: "1",
      RUBATO_CONTEXT_WINDOW_TOKENS: "24000",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  child.on("exit", (code, signal) => {
    if (code && code !== 0) stderr += `\n[exit ${code}/${signal}]`;
  });
  const rpc = attachRpc(child);
  const close = async () => {
    child.kill("SIGKILL");
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { mock, child, rpc, agentDir, cwd, home, stderr: () => stderr, close };
}

async function ready(rpc, stderr, { setModel = true } = {}) {
  if (setModel) {
    rpc.send({ id: "m1", type: "set_model", provider: "mock", modelId: "stub" });
    try {
      await rpc.wait((rec) => rec.type === "response" && rec.command === "set_model", 40000, "set_model");
    } catch (error) {
      throw new Error(`${error.message}; stderr=${(stderr?.() ?? "").slice(-1200)}`);
    }
  } else {
    await rpc.wait((rec) => rec.type === "settings_source_selected" || rec.type === "response", 40000, "rpc ready");
  }
  rpc.send({ id: "s1", type: "get_state" });
  const state = await rpc.wait((rec) => rec.type === "response" && rec.command === "get_state" && rec.id === "s1", 10000, "get_state");
  return state.data;
}

async function promptTurn(rpc, message, id = "p") {
  const ended = rpc.wait((rec) => rec.type === "agent_end" && rec.willRetry !== true, 40000, `agent_end ${id}`);
  rpc.send({ id, type: "prompt", message });
  return ended;
}

describe("real AgentSession", { concurrency: false }, () => {
test("fact 1: note is in the session file before the tool result reaches the provider", { skip: !enabled }, async () => {
  let noteAtSecondRequest = false;
  let sessionFile;
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (body, index) => {
      if (index === 1 && sessionFile) {
        noteAtSecondRequest = parseEntries(sessionFile).some((e) => e.customType === NOTE_ENTRY && JSON.stringify(e).includes(NOTE_TEXT));
      }
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      return { type: "text", text: "wrote the note" };
    },
  });
  try {
    const state = await ready(harness.rpc, harness.stderr);
    sessionFile = state.sessionFile;
    try {
      await promptTurn(harness.rpc, USER_TEXT, "p1");
    } catch (error) {
      throw new Error(`${error.message}; mockCalls=${harness.mock.requests.length}; stderr=${harness.stderr().slice(-800)}`);
    }
    const tools = harness.mock.requests[0]?.toolNames ?? [];
    assert.ok(tools.includes("notes_write_file"), `fact1: notes tools present on provider request, got ${tools.join(",")}`);
    assert.equal(harness.mock.requests.length >= 2, true, "fact1: provider was called again with the tool result");
    assert.equal(noteAtSecondRequest, true, "fact1: session file already had the note when the second provider request arrived");
  } finally {
    await harness.close();
  }
});

test("fact 2: the request that carries the new_context result is the new window", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (_body, index) => {
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      if (index === 1) return { type: "tool", name: "new_context", args: {}, id: "call_ctx" };
      if (index === 2) return { type: "tool", name: "notes_read_file", args: { path: "work.md" }, id: "call_read" };
      return { type: "text", text: "read in the new window" };
    },
  });
  try {
    await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, USER_TEXT, "p1");
    const bodies = harness.mock.requests.map((r) => r.body).filter(Boolean);
    assert.ok(bodies.length >= 3, `fact2: expected write, new_context, then new-window request; got ${bodies.length}`);
    const blob = messageBlob(bodies[2]?.messages);
    assert.ok(blob.includes("<rubato_context_window_v1>"), "fact2: new_context-result request carries the window bootstrap");
    assert.equal(blob.includes(USER_TEXT), false, "fact2: old user conversation is not in the new-window request");
    assert.equal(blob.includes(NOTE_TEXT), false, "fact2: note body is not in the new-window request");
    assert.ok((harness.mock.requests[2]?.toolNames ?? []).includes("notes_read_file"), "fact2: tool definitions remain after the switch");
  } finally {
    await harness.close();
  }
});

test("fact 3: notes_read_file result appears only on the request after the new-window call", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (_body, index) => {
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      if (index === 1) return { type: "tool", name: "new_context", args: {}, id: "call_ctx" };
      if (index === 2) return { type: "tool", name: "notes_read_file", args: { path: "work.md" }, id: "call_read" };
      return { type: "text", text: "read in the new window" };
    },
  });
  try {
    await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, USER_TEXT, "p1");
    const bodies = harness.mock.requests.map((r) => r.body).filter(Boolean);
    assert.ok(bodies.length >= 4, `fact3: expected four provider calls (write, new_context, read, result); got ${bodies.length}`);
    assert.equal(messageBlob(bodies[2]?.messages).includes(NOTE_TEXT), false, "fact3: note body is absent from the new-window request that calls notes_read_file");
    assert.ok(messageBlob(bodies[3]?.messages).includes(NOTE_TEXT), "fact3: note body appears only after notes_read_file returns");
  } finally {
    await harness.close();
  }
});

test("fact 4: note and history reads enter the provider input only after an explicit tool call", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (_body, index) => {
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      if (index === 1) return { type: "tool", name: "new_context", args: {}, id: "call_ctx" };
      if (index === 2) return { type: "text", text: "batch done" };
      if (index === 3) return { type: "tool", name: "notes_read_file", args: { path: "work.md" }, id: "call_read" };
      return { type: "text", text: "read done" };
    },
  });
  try {
    await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, USER_TEXT, "p1");
    assert.ok(harness.mock.requests.length >= 2, "fact4: write tool plus follow-up provider call");
    const first = messageBlob(harness.mock.requests[0].body?.messages);
    const second = messageBlob(harness.mock.requests[1].body?.messages);
    assert.equal(first.includes(NOTE_TEXT), false, "fact4: note body is absent from the provider request that asked for notes_write_file");
    assert.ok(second.includes(NOTE_TEXT), "fact4: note text reaches the provider only after the notes_write_file tool result");
  } finally {
    await harness.close();
  }
});

test("fact 5: consecutive requests without another switch keep the earlier prefix", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (_body, index) => {
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      if (index === 1) return { type: "tool", name: "new_context", args: {}, id: "call_ctx" };
      return { type: "text", text: `turn-${index}` };
    },
  });
  try {
    await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, USER_TEXT, "p1");
    assert.ok(harness.mock.requests.length >= 2, "fact5: consecutive provider requests in the same turn");
    const first = JSON.stringify(harness.mock.requests[0].body?.messages ?? []);
    const second = JSON.stringify(harness.mock.requests[1].body?.messages ?? []);
    assert.ok(second.includes(USER_TEXT), "fact5: later request still contains the original user message");
    assert.ok(first.includes(USER_TEXT), "fact5: first request contains the original user message");
    const userAt = first.indexOf(USER_TEXT);
    const userAt2 = second.indexOf(USER_TEXT);
    assert.equal(first.slice(userAt, userAt + USER_TEXT.length), second.slice(userAt2, userAt2 + USER_TEXT.length),
      "fact5: the original user message was not rewritten between consecutive provider calls");
  } finally {
    await harness.close();
  }
});

test("fact 6: notes mode never issues engine summary, compact approval, or Anthropic server compaction", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "history-notes" },
    script: (_body, index) => {
      if (index === 0) return { type: "tool", name: "notes_write_file", args: { path: "work.md", text: NOTE_TEXT }, id: "call_write" };
      if (index === 1) return { type: "tool", name: "new_context", args: {}, id: "call_ctx" };
      return { type: "text", text: "ok" };
    },
  });
  try {
    await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, USER_TEXT, "p1");
    const compactHeader = harness.mock.requests.some((r) => JSON.stringify(r.headers ?? {}).includes("compact-2026-01-12"));
    const summaryPrompt = harness.mock.requests.some((r) => /summarize the conversation|Write a continuation brief/i.test(messageBlob(r.body?.messages)));
    assert.equal(compactHeader, false, "fact6: no Anthropic compact-2026-01-12 header on provider requests");
    assert.equal(summaryPrompt, false, "fact6: no engine summary prompt in provider bodies");
    const blobs = harness.mock.requests.map((r) => messageBlob(r.body?.messages));
    assert.equal(blobs.some((b) => /summarize the conversation|compaction summary/i.test(b)), false,
      "fact6: no engine summary prompt in provider bodies");
  } finally {
    await harness.close();
  }
});

test("dual-mode a: summary-default model keeps today's compaction path (gates dormant)", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "summary" },
    script: () => ({ type: "text", text: "pong" }),
  });
  try {
    const state = await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, "ping", "p1");
    const entries = parseEntries(state.sessionFile);
    assert.equal(entries.some((e) => String(e.customType ?? "").startsWith("rubato.context-window.")), false,
      "dual-a: summary session did not write a notes-window entry");
    assert.equal(state.autoCompactionEnabled, true, "dual-a: auto compaction stays enabled in summary mode");
    const tools = harness.mock.requests[0]?.toolNames ?? [];
    assert.equal(tools.some((n) => /^(notes_|history_|new_context$|get_context_remaining$)/.test(n)), false,
      `dual-a/F3: summary provider request must not carry notes tools, got ${tools.join(",")}`);
    harness.rpc.send({ id: "astra-no", type: "set_model", provider: "openai-codex", modelId: "gpt-6-astra" });
    const declined = await harness.rpc.wait((rec) => rec.type === "extension_ui_request" && rec.method === "confirm", 15000, "confirm decline");
    harness.rpc.send({ type: "extension_ui_response", id: declined.id, confirmed: false });
    await harness.rpc.wait((rec) => rec.type === "response" && rec.command === "set_model" && rec.id === "astra-no", 15000, "set_model declined");
    const before = harness.mock.requests.length;
    await promptTurn(harness.rpc, "still summary", "p-no");
    const afterTools = harness.mock.requests.slice(before)[0]?.toolNames ?? [];
    assert.equal(afterTools.some((n) => /^(notes_|history_|new_context$|get_context_remaining$)/.test(n)), false,
      `dual-a/F3: declined Astra switch still has no notes tools (${afterTools.join(",")})`);
  } finally {
    await harness.close();
  }
});

test("dual-mode b: model_select to Astra confirms yes (switch+record) and no (keep summary)", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "summary" },
    script: () => ({ type: "text", text: "ok" }),
  });
  try {
    const state = await ready(harness.rpc, harness.stderr);
    harness.rpc.send({ id: "astra", type: "set_model", provider: "openai-codex", modelId: "gpt-6-astra" });
    const ui = await harness.rpc.wait(
      (rec) => rec.type === "extension_ui_request" && rec.method === "confirm",
      15000,
      "confirm for Astra",
    );
    assert.match(ui.message ?? "", /Astra는 작업 노트/);
    harness.rpc.send({ type: "extension_ui_response", id: ui.id, confirmed: true });
    await harness.rpc.wait((rec) => rec.type === "response" && rec.command === "set_model" && rec.id === "astra", 15000, "set_model astra");
    harness.rpc.send({ id: "e-yes", type: "get_entries" });
    const yes = await harness.rpc.wait((rec) => rec.type === "response" && rec.command === "get_entries" && rec.id === "e-yes", 10000, "get_entries yes");
    const yesEntries = yes.data?.entries ?? parseEntries(state.sessionFile);
    assert.ok(yesEntries.some((e) => e.customType === MODE_ENTRY && e.data?.mode === "history-notes"),
      `dual-b-yes: session recorded history-notes; types=${yesEntries.map((e) => e.customType ?? e.type).join(",")}`);
    const beforeYes = harness.mock.requests.length;
    await promptTurn(harness.rpc, "ping after switch", "p-yes");
    const yesTools = harness.mock.requests.slice(beforeYes)[0]?.toolNames ?? [];
    assert.ok(yesTools.includes("notes_write_file"), `dual-b/F3: after confirm-yes, notes tools are on the provider request (${yesTools.join(",")})`);

    harness.rpc.send({ id: "stub2", type: "set_model", provider: "mock", modelId: "stub" });
    const back = await harness.rpc.wait(
      (rec) => rec.type === "extension_ui_request" && rec.method === "confirm" && rec.id !== ui.id,
      15000,
      "confirm back to stub",
    );
    harness.rpc.send({ type: "extension_ui_response", id: back.id, confirmed: false });
    await harness.rpc.wait((rec) => rec.type === "response" && rec.command === "set_model" && rec.id === "stub2", 15000, "set_model stub");
    harness.rpc.send({ id: "e-no", type: "get_entries" });
    const no = await harness.rpc.wait((rec) => rec.type === "response" && rec.command === "get_entries" && rec.id === "e-no", 10000, "get_entries no");
    const lastMode = [...(no.data?.entries ?? [])].reverse().find((e) => e.customType === MODE_ENTRY);
    assert.equal(lastMode?.data?.mode, "history-notes", "dual-b-no: refusing the second confirm keeps the notes mode from yes");
  } finally {
    await harness.close();
  }
});

test("dual-mode c: confirm-yes persists a notes mode record for reopen", { skip: !enabled }, async () => {
  const first = await startHarness({
    env: { RUBATO_CONTEXT_MODE: "summary" },
    script: () => ({ type: "text", text: "ok" }),
  });
  try {
    await ready(first.rpc, first.stderr);
    first.rpc.send({ id: "astra", type: "set_model", provider: "openai-codex", modelId: "gpt-6-astra" });
    const ui = await first.rpc.wait((rec) => rec.type === "extension_ui_request" && rec.method === "confirm", 15000, "confirm");
    first.rpc.send({ type: "extension_ui_response", id: ui.id, confirmed: true });
    await first.rpc.wait((rec) => rec.type === "response" && rec.command === "set_model" && rec.id === "astra", 15000, "set_model");
    first.rpc.send({ id: "snap", type: "get_entries" });
    const snap = await first.rpc.wait((rec) => rec.type === "response" && rec.command === "get_entries" && rec.id === "snap", 10000, "snapshot entries");
    const list = snap.data?.entries ?? [];
    assert.ok(list.some((e) => e.customType === MODE_ENTRY && e.data?.mode === "history-notes"),
      "dual-c: confirm-yes wrote rubato.context-mode.v1 history-notes (second-process --session reopen is covered by unit session_start adoption)");
  } finally {
    await first.close();
  }
});

test("dual-mode d: child-style ORIGIN=session notes env with a Fable-like model resolves to summary", { skip: !enabled }, async () => {
  const harness = await startHarness({
    env: {
      RUBATO_CONTEXT_MODE: "history-notes",
      RUBATO_CONTEXT_MODE_ORIGIN: "session",
    },
    script: () => ({ type: "text", text: "pong" }),
  });
  try {
    const state = await ready(harness.rpc, harness.stderr);
    await promptTurn(harness.rpc, "ping", "p1");
    const entries = parseEntries(state.sessionFile);
    const mode = [...entries].reverse().find((e) => e.customType === MODE_ENTRY);
    assert.equal(mode?.data?.mode, "summary", "dual-d: inherited notes origin re-resolved to summary for mock/stub");
    assert.equal(entries.some((e) => String(e.customType ?? "").startsWith("rubato.context-window.")), false,
      "dual-d: no notes-window was opened");
  } finally {
    await harness.close();
  }
});
});
