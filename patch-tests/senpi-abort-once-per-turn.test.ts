import { describe, expect, test } from "bun:test";
import { InteractiveMode } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js";
import { AssistantMessageComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";

initTheme("dark", false);

const ui = { requestRender() {} } as any;
const proto = InteractiveMode.prototype as any;

function abortCount(text: string) {
  return (text.match(/Operation aborted/g) ?? []).length;
}

function visibleText(children: any[]) {
  return children
    .filter((child) => typeof child?.render === "function")
    .map((child) => stripAnsi(child.render(92).join("\n")))
    .join("\n");
}

function harness() {
  const children: any[] = [];
  const chatContainer = {
    children,
    addChild(c: any) {
      children.push(c);
    },
    detachChild(c: any) {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
    },
  };
  const self: any = {
    ui,
    chatContainer,
    pendingTools: new Map(),
    assistantTextSegments: new Map(),
    activeToolGroup: undefined,
    toolOutputExpanded: true,
    hideThinkingBlock: false,
    hiddenThinkingLabel: "Thinking...",
    outputPad: 1,
    isInitialized: true,
    session: { retryAttempt: 0 },
    footer: { invalidate() {} },
    settingsManager: { getShowCacheMissNotices: () => false, getSmoothStreaming: () => false },
    getMarkdownThemeWithSettings: () => undefined,
    getMarkdownTransformers: () => [],
    addContinuityNotice() {},
    streamingReveal: { stop() {}, begin() {}, setTarget() {} },
    toolArgsReveal: {
      update() {},
      finish() {},
      flush() {
        return false;
      },
      flushAll() {},
    },
  };
  self.attachToolComponent = proto.attachToolComponent.bind(self);
  self.closeToolGroup = proto.closeToolGroup.bind(self);
  self.detachAssistantTextSegments = proto.detachAssistantTextSegments.bind(self);
  self.syncTrailingAssistantText = proto.syncTrailingAssistantText.bind(self);
  self.clearPendingTools = proto.clearPendingTools.bind(self);
  self.handleEvent = proto.handleEvent.bind(self);
  self.addMessageToChat = proto.addMessageToChat.bind(self);
  self.startTurnWorkSummary = () => undefined;
  self.createToolExecutionComponent = (name: string, id: string, args: any) => {
    const component = new ToolExecutionComponent(name, id, args, {}, undefined, ui, process.cwd());
    component.setArgsComplete();
    return component;
  };
  return { self, children };
}

const think = (thinking: string) => ({ type: "thinking", thinking });
const say = (text: string) => ({ type: "text", text });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function abortedTurn() {
  return {
    role: "assistant",
    stopReason: "aborted",
    errorMessage: undefined,
    content: [
      think("먼저 파일을 열어본다."),
      call("t1", "read", { path: "a.ts" }),
      call("t2", "grep", { pattern: "x" }),
      say("여기까지 확인했어."),
      think("다음은 빌드다."),
      call("t3", "bash", { command: "bun test" }),
      call("t4", "read", { path: "b.ts" }),
      call("t5", "grep", { pattern: "y" }),
    ],
    timestamp: Date.now(),
  };
}

function replayLive(self: any, message: any) {
  self.streamingComponent = new AssistantMessageComponent(
    undefined,
    self.hideThinkingBlock,
    self.getMarkdownThemeWithSettings(),
    self.hiddenThinkingLabel,
    self.outputPad,
    self.getMarkdownTransformers(),
  );
  self.chatContainer.addChild(self.streamingComponent);
  const seen: any[] = [];
  for (const block of message.content) {
    seen.push(block);
    const snapshot = { ...message, content: [...seen], stopReason: "pending" };
    self.streamingMessage = snapshot;
    for (const [contentIndex, content] of snapshot.content.entries()) {
      if (content.type !== "toolCall" || self.pendingTools.has(content.id)) continue;
      if (snapshot.content[contentIndex - 1]?.type !== "toolCall" && contentIndex > 0) self.closeToolGroup();
      const component = self.createToolExecutionComponent(content.name, content.id, content.arguments);
      self.attachToolComponent(content.name, component);
      self.pendingTools.set(content.id, component);
    }
    self.syncTrailingAssistantText(snapshot);
  }
}

describe("사용자 중단은 턴당 abort 라벨 하나", () => {
  test("live message_end 는 도구가 많아도 abort 를 한 번만 그린다", async () => {
    const { self, children } = harness();
    const message = abortedTurn();
    replayLive(self, message);
    await self.handleEvent({ type: "message_end", message });

    const text = visibleText(children);
    expect(abortCount(text)).toBe(1);
    expect(self.pendingTools.size).toBe(0);
  });

  test("되살린 히스토리도 abort 를 한 번만 그리고 실제 도구 실패는 남긴다", () => {
    const { self, children } = harness();
    const message = abortedTurn();
    proto.renderSessionItems.call(self, [
      message,
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "ok-a" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "t2",
        content: [{ type: "text", text: "disk full" }],
        isError: true,
      },
    ], {});

    const text = visibleText(children);
    expect(abortCount(text)).toBe(1);
    expect(text).toContain("disk full");
    expect(text).toContain("ok-a");
  });

  test("중단이 아닌 턴 오류는 미완료 도구에 그대로 보인다", async () => {
    const { self, children } = harness();
    const message = {
      ...abortedTurn(),
      stopReason: "error",
      errorMessage: "provider exploded",
    };
    replayLive(self, message);
    await self.handleEvent({ type: "message_end", message });

    const text = visibleText(children);
    const hits = (text.match(/provider exploded/g) ?? []).length;
    expect(hits).toBeGreaterThan(1);
    expect(abortCount(text)).toBe(0);
  });
});
