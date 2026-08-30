import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import { nodeChildEnv, resolveNodeExecutable } from "../helpers/node-executable.mjs";
import {
  BUSY_ENTER_STATUS,
  BUSY_ENTER_STEER_STATUS,
  busyEnterHint,
  handlePendingRecallKey,
  injectBusyEnter,
  installBusyEnter,
  isBusyEnterModuleUrl,
  promoteBusyEnter,
  quietCompactionStatus,
  recallLatestPending,
  rememberBusyEnter,
  renderPendingMessages,
} from "../../src/busy-enter.mjs";

const interactivePath = join(senpiDir, "dist/modes/interactive/interactive-mode.js");
const nestedPrefix = "file:///repo/node_modules/@code-yeongyu/senpi/dist/modes/interactive/";
const hoistedPrefix = "file:///repo/node_modules/@code-yeongyu/senpi/dist/modes/interactive/";
const registerHref = new URL("../../src/no-changelog-register.mjs", import.meta.url).href;
const thisFile = fileURLToPath(import.meta.url);
const runtime = process.env.RUBATO_BUSY_ENTER_RUNTIME === "1";
const TRACKED = Symbol.for("rubato.busyEnter.tracked");

function userMessage(text, images) {
  const content = [{ type: "text", text }];
  if (images) content.push(...images);
  return { role: "user", content, timestamp: 1 };
}

function makeMode({ streaming = true, compacting = false } = {}) {
  const followUpMessages = [];
  const steeringMessages = [];
  const queuedInputOrder = [];
  const followUpQueue = { messages: [] };
  const steeringQueue = { messages: [] };
  const statuses = [];
  const displays = [];
  const session = {
    isStreaming: streaming,
    isCompacting: compacting,
    _followUpMessages: followUpMessages,
    _steeringMessages: steeringMessages,
    _queuedInputOrder: queuedInputOrder,
    _recordQueuedInput(text, mode, enqueueOrder) {
      queuedInputOrder.push({ text, mode, enqueueOrder: enqueueOrder ?? queuedInputOrder.length + 1 });
    },
    _emitQueueUpdate() {
      this.lastQueueUpdate = {
        steering: [...steeringMessages],
        followUp: [...followUpMessages],
      };
    },
    agent: {
      followUpQueue,
      steeringQueue,
      steer(message) {
        steeringQueue.messages.push(message);
      },
      followUp(message) {
        followUpQueue.messages.push(message);
      },
    },
  };
  return {
    session,
    compactionQueuedMessages: [],
    compactionInFlightMessages: [],
    statuses,
    displays,
    showStatus(message) {
      statuses.push(message);
    },
    updatePendingMessagesDisplay() {
      displays.push({
        followUp: [...session._followUpMessages],
        steering: [...session._steeringMessages],
        compaction: this.compactionQueuedMessages.map((item) => ({ ...item })),
      });
    },
  };
}

// 색을 직접 볼 수 있게 키 이름을 문자열에 박아 둔다. 실제 theme 는 ANSI 를 넣어
// 눈으로 구분하기 어렵다 — 여기서 보려는 것은 "어느 키로 칠했나" 뿐이다.
const tuiParts = {
  Spacer: class Spacer {
    constructor(size) {
      this.size = size;
      this.text = "";
    }
  },
  TruncatedText: class TruncatedText {
    constructor(text) {
      this.text = text;
    }
  },
  theme: { fg: (color, text) => `[${color}]${text}` },
};

/** pendingMessagesContainer 와 getAllQueuedMessages 를 붙여 렌더 가능한 모드로 만든다. */
function makeRenderableMode(mode, queues) {
  const children = [];
  mode.pendingMessagesContainer = {
    clear() {
      children.length = 0;
    },
    addChild(child) {
      children.push(child);
    },
  };
  mode.getAllQueuedMessages = () => queues;
  mode.getAppKeyDisplay = () => "Esc";
  return children;
}

function queueNativeFollowUp(mode, text, images) {
  const message = userMessage(text, images);
  mode.session._followUpMessages.push(text);
  mode.session._recordQueuedInput(text, "followUp");
  mode.session.agent.followUp(message);
  return message;
}

function queueNativeSteer(mode, text, images) {
  const message = userMessage(text, images);
  mode.session._steeringMessages.push(text);
  mode.session._recordQueuedInput(text, "steer");
  mode.session.agent.steer(message);
  return message;
}

function attachEditor(mode, text = "") {
  const editor = {
    text,
    autocomplete: false,
    inputs: [],
    imageMarkerState: undefined,
    getText() {
      return this.text;
    },
    setText(next) {
      this.text = next;
    },
    setImageMarkerState(state) {
      this.imageMarkerState = structuredClone(state);
    },
    restoreAttachmentState(state) {
      mode.pendingImages.clear();
      for (const [id, image] of state) mode.pendingImages.set(id, image);
    },
    isShowingAutocomplete() {
      return this.autocomplete;
    },
    handleInput(data) {
      this.inputs.push(data);
    },
  };
  mode.pendingImages = new Map();
  mode.defaultEditor = editor;
  mode.editor = editor;
  mode.keybindings = { matches: (data, action) => data === "UP" && action === "tui.editor.cursorUp" };
  mode.ui = { renders: 0, requestRender() { this.renders += 1; } };
  return editor;
}

function makeInstrumentedMode(options) {
  class InstrumentedMode {
    setupKeyHandlers() {}
  }
  installBusyEnter(InstrumentedMode.prototype, {
    matchesKey: (data, key) => data === "UP" && key === "up",
  });
  const mode = Object.assign(new InstrumentedMode(), makeMode(options));
  const editor = attachEditor(mode);
  mode.setupKeyHandlers();
  return { mode, editor };
}

if (!runtime) {
  test("URL matching targets the pinned interactive-mode module", () => {
    assert.equal(isBusyEnterModuleUrl(`${nestedPrefix}interactive-mode.js`), true);
    assert.equal(isBusyEnterModuleUrl(`${hoistedPrefix}interactive-mode.js`), true);
    assert.equal(isBusyEnterModuleUrl(`${nestedPrefix}components/settings-selector.js`), false);
    assert.equal(
      isBusyEnterModuleUrl("file:///x/@earendil-works/pi-tui/dist/terminal.js"),
      false,
    );
  });

  test("transforms are anchored, idempotent, and fail on pinned-source drift", () => {
    const source = readFileSync(interactivePath, "utf8");
    const next = injectBusyEnter(source, "file:///busy-enter.mjs");
    assert.notEqual(next, source);
    assert.match(next, /streamingBehavior: "followUp"/);
    assert.match(next, /__rubatoRememberBusyEnter\?\.\(text\)/);
    assert.match(next, /__rubatoPromoteBusyEnter\?\.\(\)/);
    assert.match(next, /__rubatoQuietCompactionStatus\?\.\(\(\) => this\.queueCompactionSubmission\(text, "followUp"\)\)/);
    assert.match(next, /__rubatoInstallBusyEnter\(InteractiveMode\.prototype, \{ Spacer, TruncatedText, matchesKey, theme \}\)/);
    assert.equal(injectBusyEnter(next, "file:///busy-enter.mjs"), next);
    assert.throws(
      () => injectBusyEnter(source.replace("text = text.trim();", "text = String(text).trim();")),
      /transform drift: submit trim guard/,
    );
    assert.throws(
      () => injectBusyEnter(source.replace(
        "                    await this.session.prompt(text, {\n                        streamingBehavior: \"steer\",",
        "                    await this.session.prompt(text, {\n                        streamingBehavior: \"queued\",",
      )),
      /transform drift: streaming prompt option/,
    );
    assert.throws(
      () => injectBusyEnter(source.replace('queueCompactionSubmission(text, "steer")', 'queueCompactionSubmission(text, "queued")')),
      /transform drift: compaction queue/,
    );
    assert.match(source, /streamingBehavior: "followUp"/);
    assert.match(next, /this\.queueCompactionSubmission\(text, "followUp"\);/);
    assert.doesNotMatch(
      next.slice(next.indexOf("async handleFollowUp()")),
      /__rubatoRememberBusyEnter/,
    );
  });

  test("transformed interactive-mode runs through an explicit child import without inherited NODE_OPTIONS", () => {
    const result = spawnSync(resolveNodeExecutable(), ["--import", registerHref, "--test", thisFile], {
      env: nodeChildEnv({ RUBATO_BUSY_ENTER_RUNTIME: "1" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });

  test("busy Enter captures exact identities without wrapping native queue methods", () => {
    const mode = makeMode();
    const methods = {
      record: mode.session._recordQueuedInput,
      steer: mode.session.agent.steer,
      followUp: mode.session.agent.followUp,
    };
    const message = queueNativeFollowUp(mode, "later");
    const record = mode.session._queuedInputOrder[0];
    rememberBusyEnter(mode, "later");
    assert.equal(mode[TRACKED].record, record);
    assert.equal(mode[TRACKED].enqueueOrder, record.enqueueOrder);
    assert.equal(mode.session._recordQueuedInput, methods.record);
    assert.equal(mode.session.agent.steer, methods.steer);
    assert.equal(mode.session.agent.followUp, methods.followUp);
    assert.equal(mode[TRACKED].message, message);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [message]);
    assert.deepEqual(mode.session._followUpMessages, ["later"]);
    // 안내문구는 chatContainer 로 가지 않는다 — 사고 블록처럼 보이던 원인.
    assert.deepEqual(mode.statuses, []);
    assert.equal(mode.displays.length, 1);
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STATUS);
  });

  test("empty Enter promotes the same still-pending follow-up object", () => {
    const mode = makeMode();
    const first = queueNativeFollowUp(mode, "keep");
    const second = queueNativeFollowUp(mode, "promote me");
    rememberBusyEnter(mode, "promote me");
    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [first]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [second]);
    assert.equal(mode.session.agent.steeringQueue.messages[0], second);
    assert.deepEqual(mode.session._followUpMessages, ["keep"]);
    assert.deepEqual(mode.session._steeringMessages, ["promote me"]);
    assert.deepEqual(mode.session._queuedInputOrder.map((item) => item.mode), ["followUp", "steer"]);
    assert.deepEqual(mode.session.lastQueueUpdate, {
      steering: ["promote me"],
      followUp: ["keep"],
    });
    // 되돌릴 수 있어야 하므로 추적을 놓지 않는다.
    assert.equal(mode[TRACKED].message, second);
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STEER_STATUS);
    assert.equal(mode.displays.length, 2);
  });

  test("Enter toggles the same message back and forth between queue and steering", () => {
    const mode = makeMode();
    const message = queueNativeFollowUp(mode, "toggle me");
    rememberBusyEnter(mode, "toggle me");

    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [message]);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, []);
    assert.deepEqual(mode.session._steeringMessages, ["toggle me"]);
    assert.deepEqual(mode.session._followUpMessages, []);
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STEER_STATUS);

    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [message]);
    assert.deepEqual(mode.session._steeringMessages, []);
    assert.deepEqual(mode.session._followUpMessages, ["toggle me"]);
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STATUS);
    assert.deepEqual(mode.session._queuedInputOrder.map((item) => item.mode), ["followUp"]);

    // 세 번째도 같은 객체를 다시 올린다.
    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [message]);
    assert.equal(mode.session.agent.steeringQueue.messages[0], message);
  });

  test("compaction Enter toggles the queued item's mode both ways", () => {
    const mode = makeMode({ streaming: false, compacting: true });
    const queued = { text: "waiting", mode: "followUp" };
    mode.compactionQueuedMessages.push(queued);
    rememberBusyEnter(mode, "waiting");
    promoteBusyEnter(mode);
    assert.equal(queued.mode, "steer");
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STEER_STATUS);
    promoteBusyEnter(mode);
    assert.equal(queued.mode, "followUp");
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STATUS);
  });

  test("empty Enter is a no-op when the tracked follow-up already drained", () => {
    const mode = makeMode();
    const message = queueNativeFollowUp(mode, "gone");
    rememberBusyEnter(mode, "gone");
    mode.session.agent.followUpQueue.messages.splice(0, 1);
    mode.session._followUpMessages.splice(0, 1);
    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session._steeringMessages, []);
    assert.equal(mode[TRACKED], undefined);
    assert.equal(message.role, "user");
  });

  test("multiple queued items promote only the tracked follow-up", () => {
    const mode = makeMode();
    const older = queueNativeFollowUp(mode, "older");
    const newer = queueNativeFollowUp(mode, "newer");
    rememberBusyEnter(mode, "newer");
    const extra = queueNativeFollowUp(mode, "later still");
    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older, extra]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [newer]);
    assert.equal(mode.session.agent.steeringQueue.messages[0], newer);
  });

  test("images stay on the same queued message object through promote", () => {
    const mode = makeMode();
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const message = queueNativeFollowUp(mode, "with image", [image]);
    rememberBusyEnter(mode, "with image");
    promoteBusyEnter(mode);
    assert.equal(mode.session.agent.steeringQueue.messages[0], message);
    assert.equal(mode.session.agent.steeringQueue.messages[0].content[1], image);
  });

  test("compaction flips only the queued item, never an in-flight one", () => {
    const mode = makeMode({ streaming: false, compacting: true });
    const inFlight = { text: "flying", mode: "followUp" };
    const queued = { text: "waiting", mode: "followUp" };
    mode.compactionInFlightMessages.push(inFlight);
    mode.compactionQueuedMessages.push(queued);
    rememberBusyEnter(mode, "waiting");
    assert.equal(mode[TRACKED].message, queued);
    promoteBusyEnter(mode);
    assert.equal(queued.mode, "steer");
    assert.equal(inFlight.mode, "followUp");
    assert.equal(mode.compactionQueuedMessages[0], queued);
    assert.equal(mode.compactionInFlightMessages[0], inFlight);
  });

  test("idle empty Enter stays a no-op and idle non-empty is left to submit", () => {
    const idle = makeMode({ streaming: false, compacting: false });
    const message = queueNativeFollowUp(idle, "pending");
    rememberBusyEnter(idle, "pending");
    promoteBusyEnter(idle);
    assert.equal(idle[TRACKED].message, message);
    assert.deepEqual(idle.session.agent.followUpQueue.messages, [message]);
    assert.deepEqual(idle.session.agent.steeringQueue.messages, []);
  });

  test("ArrowUp recalls the tracked input after it is promoted to steering", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const older = queueNativeFollowUp(mode, "older follow-up");
    const tracked = queueNativeFollowUp(mode, "tracked steering");
    rememberBusyEnter(mode, "tracked steering");
    promoteBusyEnter(mode);

    assert.equal(recallLatestPending(mode), "tracked steering");
    assert.equal(editor.getText(), "tracked steering");
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session._steeringMessages, []);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older]);
    assert.deepEqual(mode.session._followUpMessages, ["older follow-up"]);
    assert.deepEqual(mode.session._queuedInputOrder.map((record) => record.enqueueOrder), [1]);
    assert.equal(tracked.role, "user");
  });

  test("ArrowUp removes the newest native follow-up from its real queue and bookkeeping", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const older = queueNativeSteer(mode, "older steering");
    queueNativeFollowUp(mode, "newest follow-up");
    rememberBusyEnter(mode, "newest follow-up");

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.equal(editor.getText(), "newest follow-up");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, []);
    assert.deepEqual(mode.session._followUpMessages, []);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [older]);
    assert.deepEqual(mode.session._steeringMessages, ["older steering"]);
    assert.deepEqual(mode.session._queuedInputOrder.map((item) => item.text), ["older steering"]);
    assert.equal(mode[TRACKED], undefined, "recalled input must not retain the empty-Enter toggle pointer");
    assert.deepEqual(editor.inputs, []);
  });

  test("ArrowUp recomputes the tracked follow-up row after an older item drains", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    queueNativeFollowUp(mode, "older");
    const tracked = queueNativeFollowUp(mode, "tracked");
    rememberBusyEnter(mode, "tracked");

    mode.session.agent.followUpQueue.messages.splice(0, 1);
    mode.session._followUpMessages.splice(0, 1);
    mode.session._queuedInputOrder.splice(0, 1);

    assert.equal(recallLatestPending(mode), "tracked");
    assert.equal(editor.getText(), "tracked");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, []);
    assert.deepEqual(mode.session._followUpMessages, []);
    assert.deepEqual(mode.session._queuedInputOrder, []);
    assert.equal(mode[TRACKED], undefined);
    assert.equal(tracked.content[0].text, "tracked");
  });

  test("ArrowUp recomputes the tracked steering row after an older item drains", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    queueNativeSteer(mode, "older steering");
    const tracked = queueNativeFollowUp(mode, "tracked steering");
    rememberBusyEnter(mode, "tracked steering");
    promoteBusyEnter(mode);

    mode.session.agent.steeringQueue.messages.splice(0, 1);
    mode.session._steeringMessages.splice(0, 1);
    mode.session._queuedInputOrder.splice(0, 1);

    assert.equal(recallLatestPending(mode), "tracked steering");
    assert.equal(editor.getText(), "tracked steering");
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session._steeringMessages, []);
    assert.deepEqual(mode.session._queuedInputOrder, []);
    assert.equal(mode[TRACKED], undefined);
    assert.equal(tracked.content[0].text, "tracked steering");
  });

  test("a newer untracked pending item blocks recall of the tracked input", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const tracked = queueNativeFollowUp(mode, "tracked");
    rememberBusyEnter(mode, "tracked");
    const newer = queueNativeFollowUp(mode, "newer Alt+Enter");

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.equal(editor.getText(), "");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [tracked, newer]);
  });

  test("an Alt+Enter-only queue falls through to normal history", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const pending = queueNativeFollowUp(mode, "Alt+Enter only");

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [pending]);
  });

  test("two identical follow-ups keep exact orders when latest is promoted then recalled", () => {
    const { mode, editor } = makeInstrumentedMode();
    const text = "same pending text";
    const older = queueNativeFollowUp(mode, text);
    const latest = queueNativeFollowUp(mode, text);
    rememberBusyEnter(mode, text);
    assert.equal(mode[TRACKED].message, latest);

    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [latest]);
    assert.deepEqual(mode.session._queuedInputOrder.map(({ mode: queueMode, enqueueOrder }) =>
      [queueMode, enqueueOrder]), [["followUp", 1], ["steer", 2]]);

    editor.setText("");
    assert.equal(recallLatestPending(mode), text);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session._followUpMessages, [text]);
    assert.deepEqual(mode.session._steeringMessages, []);
    assert.deepEqual(mode.session._queuedInputOrder.map(({ mode: queueMode, enqueueOrder }) =>
      [queueMode, enqueueOrder]), [["followUp", 1]]);
  });

  test("duplicate text recalls the exact tracked object and enqueue record", () => {
    const { mode } = makeInstrumentedMode();
    const text = "inspect [Image #1]";
    const olderImage = { type: "image", data: "older-bytes", mimeType: "image/png" };
    const trackedImage = { type: "image", data: "tracked-bytes", mimeType: "image/png" };
    const older = queueNativeFollowUp(mode, text, [olderImage]);
    const tracked = queueNativeFollowUp(mode, text, [trackedImage]);
    rememberBusyEnter(mode, text);
    promoteBusyEnter(mode);

    assert.equal(recallLatestPending(mode), text);
    assert.deepEqual([...mode.pendingImages.entries()], [[1, trackedImage]]);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, []);
    assert.deepEqual(mode.session._queuedInputOrder.map((record) => record.enqueueOrder), [1]);
    assert.notEqual(older, tracked);
  });

  test("ArrowUp restores native image markers and payloads in marker order", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const first = { type: "image", data: "first-bytes", mimeType: "image/png" };
    const second = { type: "image", data: "second-bytes", mimeType: "image/jpeg" };
    const text = "compare [Image #1] with [Image #2]";
    queueNativeFollowUp(mode, text, [first, second]);
    rememberBusyEnter(mode, text);

    assert.equal(recallLatestPending(mode), text);
    assert.equal(editor.getText(), text);
    assert.deepEqual(editor.imageMarkerState, { ids: [1, 2], imageCounter: 2 });
    assert.deepEqual([...mode.pendingImages.entries()], [[1, first], [2, second]]);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, []);
    assert.deepEqual(mode.session._followUpMessages, []);
  });

  test("image-bearing native input falls through safely when marker restoration is unavailable", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    delete editor.setImageMarkerState;
    const image = { type: "image", data: "bytes", mimeType: "image/png" };
    const pending = queueNativeFollowUp(mode, "inspect [Image #1]", [image]);
    rememberBusyEnter(mode, "inspect [Image #1]");

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.equal(editor.getText(), "");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [pending]);
    assert.deepEqual(mode.pendingImages, new Map());
  });

  test("unsafe newest image blocks recall instead of falling through to an older safe text item", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    const older = queueNativeFollowUp(mode, "older safe text");
    rememberBusyEnter(mode, "older safe text");
    const image = { type: "image", data: "bytes", mimeType: "image/png" };
    const newest = queueNativeSteer(mode, "newest [Image #1]", [image]);
    delete editor.setImageMarkerState;

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.equal(editor.getText(), "");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [older]);
    assert.deepEqual(mode.session.agent.steeringQueue.messages, [newest]);
    assert.deepEqual(mode.session._queuedInputOrder.map((item) => item.text), ["older safe text", "newest [Image #1]"]);
  });

  test("ArrowUp recalls tracked compaction queue items but excludes in-flight transfer", () => {
    const mode = makeMode({ streaming: false, compacting: true });
    const editor = attachEditor(mode);
    const queued = { text: "queued compacted", mode: "followUp", enqueueOrder: 2, pendingEchoId: "echo-2" };
    const removedEchoes = [];
    mode.optimisticUserEchoes = { remove: (id) => removedEchoes.push(id) };
    mode.compactionQueuedMessages.push(queued);
    rememberBusyEnter(mode, queued.text);

    assert.equal(recallLatestPending(mode), queued.text);
    assert.equal(editor.getText(), queued.text);
    assert.deepEqual(mode.compactionQueuedMessages, []);
    assert.deepEqual(removedEchoes, ["echo-2"]);

    const inFlight = { text: "already transferring", mode: "steer", enqueueOrder: 3 };
    mode.compactionInFlightMessages.push(inFlight);
    mode[TRACKED] = { kind: "compaction", message: inFlight, text: inFlight.text, enqueueOrder: 3 };
    editor.setText("");
    assert.equal(recallLatestPending(mode), undefined);
    assert.deepEqual(mode.compactionInFlightMessages, [inFlight]);
  });

  test("non-empty editor falls through to normal cursor behavior without touching pending input", () => {
    const mode = makeMode();
    const editor = attachEditor(mode, "draft");
    const pending = queueNativeFollowUp(mode, "pending");

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.equal(editor.getText(), "draft");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [pending]);
  });

  test("empty editor with no recallable pending input falls through to normal history behavior", () => {
    const mode = makeMode();
    const editor = attachEditor(mode);
    mode.compactionInFlightMessages.push({ text: "unsafe", mode: "followUp", enqueueOrder: 1 });

    handlePendingRecallKey(mode, "UP", () => editor.handleInput("UP"));
    assert.deepEqual(editor.inputs, ["UP"]);
    assert.equal(editor.getText(), "");
  });

  test("inactive turns, autocomplete, custom editors, and non-cursorUp keys fall through unchanged", () => {
    const cases = [
      { configure: (mode) => { mode.session.isStreaming = false; }, key: "UP" },
      { configure: (_mode, editor) => { editor.autocomplete = true; }, key: "UP" },
      { configure: (mode) => { mode.editor = {}; }, key: "UP" },
      { configure: () => {}, key: "DOWN" },
    ];
    for (const { configure, key } of cases) {
      const mode = makeMode();
      const editor = attachEditor(mode);
      const pending = queueNativeFollowUp(mode, "pending");
      configure(mode, editor);
      handlePendingRecallKey(mode, key, () => editor.handleInput(key));
      assert.deepEqual(editor.inputs, [key]);
      assert.deepEqual(mode.session.agent.followUpQueue.messages, [pending]);
    }
  });

  test("installs the helpers and ArrowUp interception at most once per prototype", () => {
    class FakeMode {
      setupKeyHandlers() {
        this.setupCalls = (this.setupCalls ?? 0) + 1;
      }
    }
    const parts = { matchesKey: (data, key) => data === "UP" && key === "up" };
    assert.equal(installBusyEnter(FakeMode.prototype, parts), true);
    assert.equal(installBusyEnter(FakeMode.prototype, parts), false);
    assert.equal(typeof FakeMode.prototype.__rubatoRememberBusyEnter, "function");
    assert.equal(typeof FakeMode.prototype.__rubatoPromoteBusyEnter, "function");
    assert.equal(typeof FakeMode.prototype.__rubatoRecallLatestPending, "function");

    const mode = Object.assign(new FakeMode(), makeMode());
    const editor = attachEditor(mode);
    queueNativeFollowUp(mode, "installed recall");
    mode.__rubatoRememberBusyEnter("installed recall");
    mode.setupKeyHandlers();
    mode.setupKeyHandlers();
    editor.handleInput("UP");
    assert.equal(editor.getText(), "installed recall");
    assert.deepEqual(editor.inputs, []);
    assert.equal(mode.setupCalls, 2);

    editor.setText("");
    const pending = queueNativeFollowUp(mode, "not plain Up");
    mode.__rubatoRememberBusyEnter("not plain Up");
    mode.keybindings.matches = (_data, action) => action === "tui.editor.cursorUp";
    editor.handleInput("CTRL_UP");
    assert.deepEqual(editor.inputs, ["CTRL_UP"]);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [pending]);

    mode.keybindings.matches = () => false;
    editor.handleInput("UP");
    assert.equal(editor.getText(), "not plain Up", "physical plain Up must ignore a remapped cursorUp action");
    assert.deepEqual(mode.session.agent.followUpQueue.messages, []);
  });

  test("pending renderer groups modes, keeps bodies readable, and advertises single-item ArrowUp recall", () => {
    const mode = makeMode();
    queueNativeSteer(mode, "steer me");
    queueNativeFollowUp(mode, "wait");
    rememberBusyEnter(mode, "wait");
    const rendered = makeRenderableMode(mode, {
      steering: mode.session._steeringMessages,
      followUp: mode.session._followUpMessages,
    });
    assert.equal(renderPendingMessages(mode, tuiParts), true);

    assert.ok(rendered.find((child) => child.text.includes("STEERING · current turn")));
    assert.ok(rendered.find((child) => child.text.includes("NEXT TURN · follow-up")));
    const steeringBody = rendered.find((child) => child.text.includes("steer me"));
    const followUpBody = rendered.find((child) => child.text.includes("wait"));
    assert.match(steeringBody.text, /\[dim\]  └ \[text\]steer me/);
    assert.match(followUpBody.text, /\[dim\]  └ \[text\]wait/);
    for (const child of [steeringBody, followUpBody]) {
      assert.doesNotMatch(child.text, /\[dim\][^[]*(steer me|wait)/);
    }

    const recallHint = rendered.find((child) => child.text.includes("↑ edit latest Enter input"));
    assert.ok(recallHint);
    assert.match(recallHint.text, /\[dim\]/);
    assert.equal(rendered.some((child) => child.text.includes("edit all queued messages")), false);
    assert.equal(rendered.some((child) => child.text.includes("Esc")), false);
  });

  test("the busy-Enter hint rides in the pending block and flips with the toggle", () => {
    const mode = makeMode();
    const queued = [];
    const rendered = makeRenderableMode(mode, { steering: [], followUp: queued });
    queueNativeFollowUp(mode, "hint me");
    queued.push("hint me");

    assert.equal(renderPendingMessages(mode, tuiParts), true);
    assert.equal(rendered.some((child) => child.text.includes(BUSY_ENTER_STATUS)), false);

    rememberBusyEnter(mode, "hint me");
    rendered.length = 0;
    assert.equal(renderPendingMessages(mode, tuiParts), true);
    const hint = rendered.find((child) => child.text.includes(BUSY_ENTER_STATUS));
    assert.ok(hint, "hint should render inside the pending block");
    assert.match(hint.text, /\[dim\]/);
    assert.match(hint.text, /↑ edit latest Enter input.*·.*Enter 한 번 더/);

    promoteBusyEnter(mode);
    rendered.length = 0;
    assert.equal(renderPendingMessages(mode, tuiParts), true);
    assert.ok(rendered.find((child) => child.text.includes(BUSY_ENTER_STEER_STATUS)));
  });

  test("promote uses the queued (expanded) text, not the raw editor text", () => {
    // `/template args` 는 펼쳐서 큐에 들어간다. 장부를 생텍스트로 집으면
    // followUp 쪽이 안 지워지고 steer 쪽에 유령이 남는다.
    const mode = makeMode();
    const expanded = "expanded body from template";
    const message = userMessage(expanded);
    mode.session._followUpMessages.push(expanded);
    mode.session._recordQueuedInput(expanded, "followUp");
    mode.session.agent.followUp(message);

    rememberBusyEnter(mode, "/template args");
    assert.equal(mode[TRACKED].message, message);
    promoteBusyEnter(mode);

    assert.deepEqual(mode.session._followUpMessages, [], "expanded follow-up must be removed");
    assert.deepEqual(mode.session._steeringMessages, [expanded]);
    assert.deepEqual(
      mode.session._queuedInputOrder.map((item) => [item.mode, item.text]),
      [["steer", expanded]],
    );
  });

  test("toggling back restores the tracked follow-up's original position", () => {
    const mode = makeMode();
    const first = queueNativeFollowUp(mode, "first");
    const tracked = queueNativeFollowUp(mode, "tracked");
    rememberBusyEnter(mode, "tracked");
    const last = queueNativeFollowUp(mode, "last");

    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [first, last]);
    promoteBusyEnter(mode);

    assert.deepEqual(mode.session.agent.followUpQueue.messages, [first, tracked, last]);
    assert.deepEqual(mode.session._followUpMessages, ["first", "tracked", "last"]);
  });

  test("the hint disappears once the tracked message has drained", () => {
    const mode = makeMode();
    const other = queueNativeFollowUp(mode, "still queued");
    queueNativeFollowUp(mode, "tracked");
    rememberBusyEnter(mode, "tracked");
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STATUS);

    mode.session.agent.followUpQueue.messages.splice(1, 1);
    mode.session._followUpMessages.splice(1, 1);
    assert.equal(busyEnterHint(mode), undefined, "stale hint must not stay on screen");
    assert.equal(mode.session.agent.followUpQueue.messages[0], other);
  });

  test("compaction busy Enter suppresses only the duplicate queued status", () => {
    const mode = makeMode({ streaming: false, compacting: true });
    const seen = [];
    mode.showStatus = (message) => seen.push(message);
    quietCompactionStatus(mode, () => {
      mode.showStatus("Queued message for after compaction");
      mode.showStatus("Dropped 1 image: messages sent during compaction cannot carry images");
    });
    assert.deepEqual(seen, ["Dropped 1 image: messages sent during compaction cannot carry images"]);
    // 복원되어야 한다.
    mode.showStatus("Queued message for after compaction");
    assert.equal(seen.length, 2);
  });

  test("the override falls back to upstream when the TUI parts are missing", () => {
    class FakeMode {
      constructor() {
        this.upstreamCalls = 0;
      }
      updatePendingMessagesDisplay() {
        this.upstreamCalls += 1;
      }
    }
    assert.equal(installBusyEnter(FakeMode.prototype, undefined), true);
    const instance = new FakeMode();
    instance.updatePendingMessagesDisplay();
    assert.equal(instance.upstreamCalls, 1);
  });
} else {
  test("child import has a clean NODE_OPTIONS and a transformed InteractiveMode", async () => {
    assert.equal(process.env.NODE_OPTIONS ?? "", "");
    const { InteractiveMode } = await import(`${pathToFileURL(interactivePath).href}?busy=${Date.now()}`);
    assert.equal(typeof InteractiveMode.prototype.__rubatoRememberBusyEnter, "function");
    assert.equal(typeof InteractiveMode.prototype.__rubatoPromoteBusyEnter, "function");
    assert.equal(typeof InteractiveMode.prototype.__rubatoRecallLatestPending, "function");
    assert.match(InteractiveMode.prototype.setupKeyHandlers.toString(), /installPendingRecall/);
    const source = InteractiveMode.prototype.setupEditorSubmitHandler.toString();
    assert.match(source, /streamingBehavior: "followUp"/);
    assert.match(source, /queueCompactionSubmission\(text, "followUp"\)/);
    assert.doesNotMatch(source, /streamingBehavior: "steer"/);
    const followUp = InteractiveMode.prototype.handleFollowUp.toString();
    assert.match(followUp, /streamingBehavior: "followUp"/);
    assert.match(followUp, /queueCompactionSubmission\(text, "followUp"\)/);
    assert.doesNotMatch(followUp, /__rubatoRememberBusyEnter/);
  });
}
