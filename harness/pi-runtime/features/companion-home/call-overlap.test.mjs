// A live call driven through a real Pi session with a faux model and the real call bridge over HTTP.
// The person's lines steer into the companion's work the way chat messages do, and the companion
// can speak, work and speak again while the call is open.
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
const wait = (ms = 10) => new Promise((done) => setTimeout(done, ms));
const eventsOf = async (response) => (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function liveCall(t, name) {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
  const { AssistantMessageEventStream } = await import(
    pathToFileURL(join(packageDir, "../../@earendil-works/pi-ai/dist/utils/event-stream.js")).href
  ).catch(() => import(pathToFileURL(join(packageDir, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href));
  const root = join(scratch, name), cwd = join(root, "cwd"), agentDir = join(root, "agent"), home = join(root, "home");
  for (const dir of [cwd, agentDir, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "call-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } },
  }));

  // A slow lookup the companion runs while it is on the call, like reading a chat room.
  const looks = [];
  const lookTool = (pi) => pi.registerTool({ name: "look", label: "look", description: "Look something up.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_id, _args, signal) {
      const look = { finished: false, aborted: false };
      looks.push(look);
      await new Promise((done) => { look.release = done; signal?.addEventListener("abort", () => { look.aborted = true; done(); }, { once: true }); });
      look.finished = !look.aborted;
      return { content: [{ type: "text", text: look.aborted ? "aborted" : "형님 메시지 40줄" }] };
    } });
  let bridge;
  const callBridge = (pi) => {
    bridge = createCompanionCall(pi, { env: { HOME: home, RUBATO_COMPANION_HOME: home },
      config: { enabled: true, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000, recordTranscripts: false } });
  };
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "companion-call", factory: callBridge }, { name: "look", factory: lookTool }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd) });
  await session.bindExtensions({});
  t.after(async () => { for (const look of looks) look.release?.(); await bridge.close(); session.dispose?.(); });
  await wait(50);
  const base = `http://127.0.0.1:${bridge.address().port}`;

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason) => ({ role: "assistant", content, api: "openai-completions",
    provider: "call-test", model: "fake", usage, stopReason, timestamp: Date.now() });
  /** One model step: tool calls given as [name, id, args]; a say is [CALL_SAY_TOOL, id, text]. */
  const step = (...calls) => {
    const content = calls.map(([toolName, id, value]) => ({ type: "toolCall", id, name: toolName,
      arguments: toolName === CALL_SAY_TOOL ? { text: value } : (value ?? {}) }));
    const message = assistant(content, "toolUse");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    content.forEach((toolCall, contentIndex) => {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
    });
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  };
  const requests = [];
  let script = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context.messages)));
    const next = script[requests.length - 1];
    if (next) return next();
    const done = assistant([{ type: "text", text: "unscripted request" }], "stop");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...done, content: [] } });
    stream.push({ type: "done", reason: "stop", message: done });
    return stream;
  };
  const turn = (text, turnId, signal) => fetch(`${base}/call/turn`, { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ text, turnId }) });
  const watch = async (callId) => {
    const response = await fetch(`${base}/call/health?watch=1&callId=${callId}`);
    const items = [];
    (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for await (const chunk of response.body) {
          buffered += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line) items.push(JSON.parse(line));
          }
        }
      } catch {}
    })();
    return { items, close: () => response.body.cancel().catch(() => {}) };
  };
  return { session, bridge, looks, requests, step, turn, watch, setScript: (steps) => { script = steps; } };
}

test("the companion says it will look, looks, and speaks the result without being asked again", async (t) => {
  // The 2026-11-22 call: Roo read the room in 11 seconds and its words were refused because the
  // turn had closed with its first call_say; it stayed silent until the person asked again.
  const call = await liveCall(t, "look-and-tell");
  const { step } = call;
  call.setScript([
    () => step([CALL_SAY_TOOL, "will-look", "응, 잠깐만 볼게."], ["look", "look-1"]),
    () => step([CALL_SAY_TOOL, "found", "봤어. 한 줄에 세 단어씩 던지더라."]),
  ]);
  const open = await call.watch("c1");
  const first = await eventsOf(await call.turn("개발방 읽어봐", "line-1"));
  assert.equal(first.filter((row) => row.t === "delta").map((row) => row.text).join(""), "응, 잠깐만 볼게.");
  while (call.looks.length < 1) await wait();
  call.looks[0].release();
  for (const end = Date.now() + 2000; !open.items.some((item) => item.t === "say_end");) {
    if (Date.now() > end) assert.fail(`the result was never spoken; the call stream carried ${JSON.stringify(open.items)}`);
    await wait();
  }
  assert.deepEqual(open.items.filter((item) => item.t === "say").map((item) => item.text).join(""), "봤어. 한 줄에 세 단어씩 던지더라.");
  await wait(50);
  assert.equal(call.session.isIdle, true);
  assert.equal(call.requests.length, 2);
  await open.close();
});

test("a line spoken while the companion works steers into that work, which finishes", async (t) => {
  const call = await liveCall(t, "steer");
  const { step } = call;
  call.setScript([
    () => step([CALL_SAY_TOOL, "will-search", "응, 찾아볼게."], ["look", "look-1"]),
    // Steered lines enter one per step: this answers the second line while the third waits.
    () => step([CALL_SAY_TOOL, "stale", "알겠어, 천천히 볼게."]),
    () => step([CALL_SAY_TOOL, "found", "다 찾았어. 18일 밤에 한 번 썼더라."]),
  ]);
  const open = await call.watch("c1");
  await eventsOf(await call.turn("턴이라는 말 찾아봐", "line-1"));
  while (call.looks.length < 1) await wait();
  // The call client cuts this line off (the person started a new one); the lookup goes on.
  const cut = new AbortController();
  const second = await call.turn("천천히 해도 돼", "line-2", cut.signal);
  while (!call.session.getSteeringMessages().length) await wait();
  cut.abort();
  await second.body?.cancel().catch(() => {});
  const third = call.turn("천천히 해도 돼. 18일 쪽 봐", "line-3");
  while (call.session.getSteeringMessages().length < 2) await wait();
  await wait(30);
  assert.equal(call.looks[0].aborted, false, "nothing the person says stops the lookup");
  call.looks[0].release();

  const rows = await eventsOf(await third);
  assert.equal(rows.filter((row) => row.t === "delta").map((row) => row.text).join(""), "다 찾았어. 18일 밤에 한 번 썼더라.");
  assert.equal(call.looks[0].finished, true);
  assert.match(JSON.stringify(call.requests[1].find((message) => message.role === "toolResult" && message.toolCallId === "look-1").content), /형님 메시지 40줄/);
  assert.match(JSON.stringify(call.requests[1].at(-1)), /\[voice\] 천천히 해도 돼"/);
  assert.match(JSON.stringify(call.requests[2].at(-1)), /\[voice\] 천천히 해도 돼\. 18일 쪽 봐/);
  assert.doesNotMatch(JSON.stringify(rows), /천천히 볼게/, "words for a line the person talked over stay unspoken");
  assert.equal(open.items.some((item) => item.t === "say"), false, "an answer to a heard line goes out with that line");
  await wait(50);
  assert.equal(call.session.isIdle, true);
  await open.close();
});

test("words written for a line the person talked over stay unspoken, and the newer line is answered", async (t) => {
  const call = await liveCall(t, "talked-over");
  const { step } = call;
  let secondQueued;
  const queued = new Promise((done) => { secondQueued = done; });
  call.setScript([
    // Still writing the answer to the first line when the person keeps talking.
    () => {
      const stream = step([CALL_SAY_TOOL, "stale", "앱을 만들었다고? 폰이야, 맥이야?"]);
      const held = new (stream.constructor)();
      void queued.then(async () => { for await (const event of stream) held.push(event); });
      return held;
    },
    () => step([CALL_SAY_TOOL, "answer", "모바일 앱! 이제 폰만 있으면 어디서든 나 부를 수 있네."]),
  ]);
  const client = new AbortController();
  const first = await call.turn("어 통화 되네, 신기하다. 아니 이제 앱도 만들었거든.", "first", client.signal);
  while (call.requests.length < 1) await wait();
  client.abort();
  await first.body?.cancel().catch(() => {});
  const second = call.turn("모바일 앱.", "second");
  while (!call.session.getSteeringMessages().length) await wait();
  secondQueued();

  const rows = await eventsOf(await second);
  assert.equal(rows.filter((row) => row.t === "delta").map((row) => row.text).join(""), "모바일 앱! 이제 폰만 있으면 어디서든 나 부를 수 있네.");
  assert.doesNotMatch(JSON.stringify(rows), /폰이야, 맥이야/, "words that answered only the older line stay unspoken");
  const seen = call.requests[1];
  const stale = seen.find((message) => message.role === "toolResult" && message.toolCallId === "stale");
  assert.match(JSON.stringify(stale.content), /newer line comes in right after this/);
  assert.match(JSON.stringify(seen.at(-1)), /\[voice\] 모바일 앱\./);
  await wait(50);
  assert.equal(call.session.isIdle, true);
});

test("a reply the person cut off reaches the model only as far as it was heard", async (t) => {
  const call = await liveCall(t, "cut-read-back");
  const { step } = call;
  const reply = "좀 풀리는 중이면 다행이다. 근데 PCCP 있는 거 알지? 오늘은 좀 자자!";
  call.setScript([
    () => step([CALL_SAY_TOOL, "long", reply]),
    () => step([CALL_SAY_TOOL, "again", "아, 좀 풀린다고 했어."]),
  ]);
  await eventsOf(await call.turn("조금 풀렸어", "line-1"));
  const cut = { said: reply, heardSeconds: 2, pace: [{ text: "가나다라마바사아자차가나", seconds: 2 }] };
  const rows = await eventsOf(await fetch(`http://127.0.0.1:${call.bridge.address().port}/call/turn`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "아까", turnId: "line-2", cut }) }));
  assert.equal(rows.at(-1).source, CALL_SAY_TOOL);
  const said = call.requests[1].find((message) => message.role === "assistant").content.find((block) => block.id === "long");
  assert.equal(said.arguments.text, "좀 풀리는 중이면 다행이다.—");
  assert.equal(JSON.stringify(call.requests[1].at(-1)).includes("끊겼"), false, "the person's words carry no note");
  assert.match(JSON.stringify(call.session.messages), /오늘은 좀 자자!/, "the stored conversation keeps what was written");
});
