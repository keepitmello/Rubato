import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { collapseToolsByName, compactTools, retriedErrorMessages } from "./assistant-phase.mjs";
import feature, { patchAssistantMessage, patchInteractiveTurnChrome } from "./patches.mjs";

const stock = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent/dist");

test("bash·read·bash becomes bash (2)·read in first-seen order", () => {
  const named = (name) => ({ name, failed: false });
  assert.deepEqual(
    collapseToolsByName([named("bash"), named("read"), named("bash")]).map(({ name, count }) => `${name}:${count}`),
    ["bash:2", "read:1"],
  );
  assert.deepEqual(
    collapseToolsByName([named("bash"), named("bash"), named("read")]).map(({ name, count }) => `${name}:${count}`),
    ["bash:2", "read:1"],
  );
});

test("turn summary names tools from the component's Set of groups", () => {
  const group = (...names) => ({ workItems: () => names.map((name) => ({ name, failed: name === "eval" })) });
  const groups = new Set([group("bash", "read"), group("bash", "eval")]);
  assert.equal(compactTools(groups, 80), "✓ bash (2) · ✓ read · ✗ eval");
  assert.equal(compactTools(groups, 16), "✓ bash (2) · …+2");
});

test("turn chrome hosts thinking on one toggle and skips per-message thinking", () => {
  const assistant = patchAssistantMessage(readFileSync(join(stock, "modes/interactive/components/assistant-message.js"), "utf8"));
  assert.match(assistant, /setHostThinking\(hosted\)/);
  assert.match(assistant, /this\.turnWorkCollapsed \|\| this\.hostThinking/);
  const interactive = patchInteractiveTurnChrome(readFileSync(join(stock, "modes/interactive/interactive-mode.js"), "utf8"));
  assert.match(interactive, /TurnThinkingComponent/);
  assert.match(interactive, /this\.streamingComponent\.setHostThinking\?\.\(true\)/);
  assert.match(interactive, /this\.turnThinking\?\.trackAssistant/);
});

// Shape of session 01a0d770 (2026-09-25) lines 39-60: failed attempts that a
// retry recovered, a chain that ran out, and a chain the user ended.
const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage, content: [] });
const answered = () => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "ok" }] });
const recovered = failed("Connection error.");
const exhaustedChain = [failed("Connection error."), failed("Request timed out."), failed("Connection error.")];
const exhausted = failed("Connection error.");
const user = { role: "user", content: [{ type: "text", text: "cli로 왔어" }] };
const aborted = failed("Request aborted");
const history = [recovered, answered(), { type: "custom", customType: "rubato-memory:accepted-turns" },
  ...exhaustedChain, exhausted, user, answered(), { role: "toolResult", toolCallId: "t", content: [] },
  failed("Connection error."), failed("Request timed out."), aborted];

test("a stored error was retried when another assistant message comes before the user", () => {
  const retried = retriedErrorMessages(history);
  assert.equal(retried.has(recovered), true);
  for (const attempt of exhaustedChain) assert.equal(retried.has(attempt), true);
  assert.equal(retried.has(exhausted), false);
  assert.equal(retried.has(aborted), false);
  assert.equal(retried.size, 6);
});

const scratch = mkdtempSync(join(tmpdir(), "rubato-turn-chrome-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let staging;
const staged = () => staging ??= (async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const root = (await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "stage"), features: [feature] })).root;
  const agentDir = resolvePiRuntime({ root }).codingAgentDir;
  const load = (path) => import(pathToFileURL(join(agentDir, path)).href);
  (await load("dist/modes/interactive/theme/theme.js")).initTheme("dark");
  const { AssistantMessageComponent } = await load("dist/modes/interactive/components/assistant-message.js");
  const { InteractiveMode } = await load("dist/modes/interactive/interactive-mode.js");
  const { Container } = await load("node_modules/@earendil-works/pi-tui/dist/index.js");
  return { AssistantMessageComponent, InteractiveMode, Container };
})();
const errorLines = (component) => component.render(80)
  .map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "").trim())
  .filter((line) => line.startsWith("Error:"));

test("the live TUI drops a retried attempt's Error line and keeps the final one", async () => {
  const { AssistantMessageComponent, InteractiveMode } = await staged();
  const host = {
    isInitialized: true, footer: { invalidate() {} }, ui: { requestRender() {} }, pendingTools: new Map(),
    defaultEditor: { onEscape: undefined }, session: { retryAttempt: 0, abortRetry() {} },
    // The real retry indicator spins timers; stop it so the run can exit.
    maybeSuggestBugReport() {}, showStatusIndicator: (indicator) => indicator.dispose(),
  };
  const attempt = async (message) => {
    const component = host.streamingComponent = new AssistantMessageComponent(undefined);
    host.streamingMessage = message;
    await InteractiveMode.prototype.handleEvent.call(host, { type: "message_end", message });
    return component;
  };
  const first = await attempt(failed("Connection error."));
  assert.deepEqual(errorLines(first), ["Error: Connection error."]);
  await InteractiveMode.prototype.handleEvent.call(host, { type: "auto_retry_start", attempt: 1, maxAttempts: 3,
    delayMs: 1000, errorMessage: "Connection error." });
  assert.deepEqual(errorLines(first), []);
  // Nothing retries the last attempt: it is the turn's answer.
  const last = await attempt(failed("Request timed out."));
  assert.deepEqual(errorLines(last), ["Error: Request timed out."]);
});

test("resuming a session replays only the errors that ended their turn", async () => {
  const { InteractiveMode, Container } = await staged();
  // Some of these are getters on the real class; own data properties shadow them.
  const host = Object.create(InteractiveMode.prototype, Object.getOwnPropertyDescriptors({
    chatContainer: new Container(), pendingTools: new Map(), ui: { requestRender() {} },
    settingsManager: { getShowCacheMissNotices: () => false, getShowImages: () => false, getImageWidthCells: () => 0 },
    hideThinkingBlock: false, hiddenThinkingLabel: "Thinking...", outputPad: 1, toolOutputExpanded: false,
    getMarkdownThemeWithSettings: () => undefined, getMarkdownTransformers: () => [],
    getRegisteredToolDefinition: () => undefined, sessionManager: { getCwd: () => scratch },
    addCustomEntryToChat() {},
  }));
  // Only assistant rendering is under test; user rows need a fully built TUI.
  host.addMessageToChat = function (message) {
    if (message.role === "assistant") InteractiveMode.prototype.addMessageToChat.call(this, message);
  };
  host.renderSessionItems(history);
  assert.deepEqual(host.chatContainer.children.flatMap(errorLines), ["Error: Connection error.", "Error: Request aborted"]);
});
