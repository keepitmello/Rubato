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
  injectBusyEnter,
  installBusyEnter,
  isBusyEnterModuleUrl,
  promoteBusyEnter,
  quietCompactionStatus,
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
    _removeQueuedInput(text, mode) {
      const index = queuedInputOrder.findIndex((item) => item.mode === mode && item.text === text);
      if (index !== -1) queuedInputOrder.splice(index, 1);
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
    assert.match(next, /__rubatoInstallBusyEnter\(InteractiveMode\.prototype, \{ Spacer, TruncatedText, theme \}\)/);
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

  test("busy Enter queues follow-up without writing a status line into the chat", () => {
    const mode = makeMode();
    const message = queueNativeFollowUp(mode, "later");
    rememberBusyEnter(mode, "later");
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

  test("installs the helpers at most once per prototype", () => {
    class FakeMode {}
    assert.equal(installBusyEnter(FakeMode.prototype), true);
    assert.equal(installBusyEnter(FakeMode.prototype), false);
    assert.equal(typeof FakeMode.prototype.__rubatoRememberBusyEnter, "function");
    assert.equal(typeof FakeMode.prototype.__rubatoPromoteBusyEnter, "function");
  });

  test("queued message bodies render undimmed, only labels and hints stay dim", () => {
    const mode = makeMode();
    const rendered = makeRenderableMode(mode, { steering: ["steer me"], followUp: ["wait"] });
    assert.equal(renderPendingMessages(mode, tuiParts), true);

    const body = rendered.find((child) => child.text.includes("steer me"));
    assert.ok(body, "steering message should be rendered");
    // 본문은 편집기와 같은 text 색 — 이게 dim 이면 읽기 힘들다는 보고가 다시 나온다.
    assert.match(body.text, /\[text\]steer me/);
    assert.match(body.text, /\[dim\]Steering: /);

    const followUp = rendered.find((child) => child.text.includes("wait"));
    assert.match(followUp.text, /\[text\]wait/);
    assert.match(followUp.text, /\[dim\]Follow-up: /);

    for (const child of rendered) {
      assert.doesNotMatch(child.text, /\[dim\][^[]*(steer me|wait)/);
    }
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

  test("toggling back restores the original follow-up position", () => {
    const mode = makeMode();
    const first = queueNativeFollowUp(mode, "first");
    const second = queueNativeFollowUp(mode, "second");
    rememberBusyEnter(mode, "first");

    promoteBusyEnter(mode);
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [second]);
    promoteBusyEnter(mode);

    // 다시 앞자리로 — append 면 [second, first] 가 되어 사용자가 친 순서가 바뀜다.
    assert.deepEqual(mode.session.agent.followUpQueue.messages, [first, second]);
    assert.deepEqual(mode.session._followUpMessages, ["first", "second"]);
  });

  test("the hint disappears once the tracked message has drained", () => {
    const mode = makeMode();
    queueNativeFollowUp(mode, "tracked");
    const other = queueNativeFollowUp(mode, "still queued");
    rememberBusyEnter(mode, "tracked");
    assert.equal(busyEnterHint(mode), BUSY_ENTER_STATUS);

    // 추적하던 것만 배달되어 빠졌다. 다른 대기열은 그대로다.
    mode.session.agent.followUpQueue.messages.splice(0, 1);
    mode.session._followUpMessages.splice(0, 1);
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
