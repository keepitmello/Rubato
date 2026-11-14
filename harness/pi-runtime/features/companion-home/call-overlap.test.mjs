// The person keeps talking while the companion is still answering on a live call (2026-11-14):
// the call client cancels the first answer, a run something else queued on settle starts in the
// gap, and the newer line is steered in behind that run's step. Drives a real Pi session with a
// faux model and the real call bridge over HTTP.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { CALL_SAY_TOOL, createCompanionCall } from "./call.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolvePiRuntime({ root: resolve(featureDir, "../..") }).codingAgentDir;
const scratch = mkdtempSync(join(tmpdir(), "rubato-call-overlap-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a line spoken while the first answer is cancelled reaches the speaker through its own call_say", async (t) => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
  const { AssistantMessageEventStream } = await import(
    pathToFileURL(join(packageDir, "../../@earendil-works/pi-ai/dist/utils/event-stream.js")).href
  ).catch(() => import(pathToFileURL(join(packageDir, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href));
  const cwd = join(scratch, "cwd"), agentDir = join(scratch, "agent"), home = join(scratch, "home");
  for (const dir of [cwd, agentDir, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "call-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } },
  }));

  let bridge, queueOnSettle = false;
  const callBridge = (pi) => {
    bridge = createCompanionCall(pi, { env: { HOME: home, RUBATO_COMPANION_HOME: home },
      config: { enabled: true, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000, recordTranscripts: false } });
  };
  // Anything that starts a run when one settles: a wake, another conversation's message.
  const settleRun = (pi) => pi.on("agent_settled", () => {
    if (!queueOnSettle) return;
    queueOnSettle = false;
    pi.sendMessage({ customType: "gap-run", content: "something else asks for a turn", display: false }, { deliverAs: "followUp", triggerTurn: true });
  });
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "companion-call", factory: callBridge }, { name: "settle-run", factory: settleRun }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd) });
  await session.bindExtensions({});
  t.after(async () => { await bridge.close(); session.dispose?.(); });
  await new Promise((done) => setTimeout(done, 50));
  const base = `http://127.0.0.1:${bridge.address().port}`;

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason) => ({ role: "assistant", content, api: "openai-completions",
    provider: "call-test", model: "fake", usage, stopReason, timestamp: Date.now() });
  const say = (id, value) => {
    const toolCall = { type: "toolCall", id, name: CALL_SAY_TOOL, arguments: { text: value } };
    const message = assistant([toolCall], "toolUse");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  };
  let gapRequested, secondPosted;
  const gapStarted = new Promise((done) => { gapRequested = done; });
  const secondQueued = new Promise((done) => { secondPosted = done; });
  const requests = [];
  session.agent.streamFunction = (_model, context, options) => {
    requests.push(JSON.parse(JSON.stringify(context.messages)));
    if (requests.length === 1) {
      // Still thinking about the first line when the client cancels it.
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: assistant([], "stop") });
      options.signal.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted",
        error: assistant([], "aborted") }), { once: true });
      return stream;
    }
    if (requests.length === 2) {
      // The gap run answers the first line, after the newer one is already queued behind it.
      gapRequested();
      const stream = new AssistantMessageEventStream();
      void secondQueued.then(() => {
        const ready = say("gap-say", "앱을 만들었다고? 폰이야, 맥이야?");
        (async () => { for await (const event of ready) stream.push(event); })();
      });
      return stream;
    }
    if (requests.length === 3) return say("answer", "모바일 앱! 이제 폰만 있으면 어디서든 나 부를 수 있네.");
    const done = assistant([{ type: "text", text: "unscripted request" }], "stop");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...done, content: [] } });
    stream.push({ type: "done", reason: "stop", message: done });
    return stream;
  };
  const turn = (text, turnId, signal) => fetch(`${base}/call/turn`, { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ text, turnId }) });
  const eventsOf = async (response) => (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const client = new AbortController();
  const first = await turn("어 통화 되네, 신기하다. 아니 이제 앱도 만들었거든.", "first", client.signal);
  while (requests.length < 1) await new Promise((done) => setTimeout(done, 10));
  queueOnSettle = true;
  client.abort();
  await first.body?.cancel().catch(() => {});
  await gapStarted;
  const second = turn("모바일 앱.", "second");
  while (!session.getSteeringMessages().length) await new Promise((done) => setTimeout(done, 10));
  secondPosted();

  const rows = await eventsOf(await second);
  assert.equal(rows.filter((row) => row.t === "delta").map((row) => row.text).join(""), "모바일 앱! 이제 폰만 있으면 어디서든 나 부를 수 있네.");
  assert.equal(rows.at(-1).source, CALL_SAY_TOOL);
  assert.doesNotMatch(JSON.stringify(rows), /폰이야, 맥이야/, "words that answered only the cancelled line stay unspoken");

  // The model that answered the newer line saw it, after an honest note on the unspoken words.
  assert.equal(requests.length, 3);
  const seen = requests[2];
  const gapResult = seen.find((message) => message.role === "toolResult" && message.toolCallId === "gap-say");
  assert.match(JSON.stringify(gapResult.content), /newer line comes in right after this/);
  assert.match(JSON.stringify(seen.at(-1)), /\[voice\] 모바일 앱\./);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(session.isIdle, true);
});
