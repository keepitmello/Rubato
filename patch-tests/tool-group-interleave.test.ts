import { describe, expect, test } from "bun:test";
import { InteractiveMode } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { ToolGroupComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-group.js";
import { AssistantMessageComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

const ui = { requestRender() {} } as any;

/**
 * 한 턴 안에서 도구와 말이 번갈아 나오는 배치를, 실제 attach/sync 메서드를
 * 최소 `this` 에 얹어 돌린다. 화면에 보이는 순서는 chatContainer.children 이므로
 * 그 배열의 모양이 곧 사용자가 보는 것이다.
 */
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
    toolOutputExpanded: false,
    hideThinkingBlock: false,
    hiddenThinkingLabel: "Thinking...",
    outputPad: 1,
    streamingComponent: { updateContent() {} },
    getMarkdownThemeWithSettings: () => undefined,
    getMarkdownTransformers: () => [],
  };
  const proto = InteractiveMode.prototype as any;
  self.attachToolComponent = proto.attachToolComponent.bind(self);
  self.closeToolGroup = proto.closeToolGroup.bind(self);
  self.detachAssistantTextSegments = proto.detachAssistantTextSegments.bind(self);
  self.syncTrailingAssistantText = proto.syncTrailingAssistantText.bind(self);
  return { self, children };
}

function toolComponent(name: string, args: any) {
  const c = new ToolExecutionComponent(name, "t" + Math.random(), args, {}, undefined, ui, process.cwd());
  c.setArgsComplete();
  return c;
}

/** children 배열을 보이는 순서 그대로 거친 모양으로 옮긴다. */
function shape(children: any[]) {
  return children.map((c) => {
    if (c instanceof ToolGroupComponent) return `group(${c.tools.map((t: any) => t.identity?.toolName ?? "?").join(",")})`;
    if (c instanceof AssistantMessageComponent) return "text";
    if (c instanceof ToolExecutionComponent) return `solo(${(c as any).identity?.toolName ?? "?"})`;
    return "other";
  });
}

/**
 * 한 번의 message_update 이벤트를 진짜 순서대로 흔낸다: 스냅샷에 들어있는 도구를
 * 전부 먼저 붙이고, 그 다음에 말을 동기화한다. 이 순서가 버그가 사는 자리라,
 * 테스트가 편하게 한 블록씩 붙이면 결함을 그대로 가린다.
 */
function streamUpdate(self: any, blocks: any[]) {
  const message = { role: "assistant", content: blocks, stopReason: "pending" };
  self.streamingMessage = message;
  for (const [contentIndex, block] of blocks.entries()) {
    if (block.type !== "toolCall" || self.pendingTools.has(block.id)) continue;
    if (blocks[contentIndex - 1]?.type !== "toolCall" && contentIndex > 0) self.closeToolGroup();
    const component = toolComponent(block.name, block.arguments ?? {});
    self.attachToolComponent(block.name, component);
    self.pendingTools.set(block.id, component);
  }
  self.syncTrailingAssistantText(message);
}

/** 스트리밍 한 턴을 블록이 하나씩 늘어나는 업데이트 연속으로 재생한다. */
function replay(self: any, content: any[]) {
  const seen: any[] = [];
  for (const block of content) {
    seen.push(block);
    streamUpdate(self, [...seen]);
  }
}

let n = 0;
const call = (name: string, args: any = {}) => ({ type: "toolCall", id: "c" + n++, name, arguments: args });
const say = (text: string) => ({ type: "text", text });

/** 되살리기 경로가 그린 말 한 덩어리를 자리 표시만 되는 가벼운 객체로 바꾼다. */
function mark(message: any) {
  return Object.assign(Object.create(AssistantMessageComponent.prototype), { __message: message });
}

/** 저장된 메시지를 되살리는 진짜 경로를 최소 한 `this` 에 얹어 띄운다. */
function replayHistory(self: any, message: any) {
  (InteractiveMode.prototype as any).renderSessionItems.call(self, [message], {});
}

describe("도구와 말이 섞인 턴", () => {
  test("말이 끼면 뭉침이 끊기고, 그 뒤 도구는 새 뭉침이 된다", () => {
    const { self, children } = harness();
    replay(self, [
      call("bash", { command: "bun test" }),
      call("read", { path: "a.ts" }),
      say("첫 번째 확인했어."),
      call("grep", { pattern: "x" }),
      call("bash", { command: "bun run build" }),
      say("두 번째도 됐어."),
      call("read", { path: "b.ts" }),
    ]);

    // 도구가 위로 뭉치지 않고, 말이 나온 자리에서 갈라져야 한다.
    expect(shape(children)).toEqual([
      "group(bash,read)",
      "text",
      "group(grep,bash)",
      "text",
      "group(read)",
    ]);
  });

  test("말 뒤의 도구가 앞 뭉침에 흡수되지 않는다", () => {
    const { self, children } = harness();
    replay(self, [call("bash", { command: "ls" }), say("확인."), call("read", { path: "a.ts" })]);

    const groups = children.filter((c) => c instanceof ToolGroupComponent);
    expect(groups).toHaveLength(2);
    expect(groups[0].size).toBe(1);
    expect(groups[1].size).toBe(1);
  });

  test("말이 없으면 연속 도구는 그대로 한 뭉치다", () => {
    const { self, children } = harness();
    replay(self, [call("bash", { command: "a" }), call("read", { path: "b" }), call("grep", { pattern: "c" })]);

    expect(shape(children)).toEqual(["group(bash,read,grep)"]);
  });

  // syncTrailingAssistantText 는 message_update 마다 불린다. 말이 한 글자씩
  // 늘어나는 동안 그때마다 뭉침을 닫으면, 그 뒤 연속된 도구가 한 개씩
  // 쌍어져 뭉침이 산산조각 난다. 닫는 것은 런당 한 번이어야 한다.
  test("말이 길어져도 뒤의 도구는 한 뭉치로 모인다", () => {
    const { self, children } = harness();
    const first = call("bash", { command: "a" });
    const t2 = call("read", { path: "b" });
    const t3 = call("grep", { pattern: "c" });

    const push = (blocks: any[]) => streamUpdate(self, blocks);

    // 말이 글자씩 자라는 동안 같은 런이 계속 다시 흘러들어온다.
    push([first]);
    push([first, say("확")]);
    push([first, say("확인")]);
    push([first, say("확인했어")]);
    // 그 뒤로 도구 둘이 연달아 온다 — 한 뭉치여야 한다.
    push([first, say("확인했어"), t2]);
    push([first, say("확인했어"), t2, t3]);

    expect(shape(children)).toEqual(["group(bash)", "text", "group(read,grep)"]);
  });

  // 진짜 message_update 는 스냅샷의 도구를 전부 먼저 붙이고 그 다음에야 말을
  // 동기화한다. 한 번의 업데이트에 "새 말 + 그 뒤 도구" 가 같이 실려 오면,
  // 도구가 먼저 앞 뭉침에 붙어버려서 말이 나중에 닫아도 이미 늦는다.
  test("한 업데이트에 말과 도구가 같이 와도 갈라진다", () => {
    const { self, children } = harness();
    const t1 = call("bash", { command: "a" });
    const t2 = call("read", { path: "b" });
    const t3 = call("grep", { pattern: "c" });

    // 실제 message_update 순서: 스냅샷의 도구를 전부 붙인 뒤 한 번 sync.
    const update = (blocks: any[]) => streamUpdate(self, blocks);

    update([t1]);
    // 말과 뒤 도구 둘이 한 스냅샷에 한꺼번에 드러난다.
    update([t1, say("확인했어."), t2, t3]);

    expect(shape(children)).toEqual(["group(bash)", "text", "group(read,grep)"]);
  });

  // 앵커를 뭉침에서 찾게 바꿨으니, 뭉치지 않는 도구(task 등)가 뒤에 올 때도
  // 그대로 들어가야 한다 — 그건 chatContainer 의 직접 자식이다.
  test("뭉치지 않는 도구 앞에도 말이 제자리에 들어간다", () => {
    const { self, children } = harness();
    replay(self, [
      call("bash", { command: "a" }),
      say("이제 위임할게."),
      call("task", { prompt: "go" }),
      say("띄웠어."),
      call("read", { path: "b.ts" }),
    ]);

    expect(shape(children)).toEqual(["group(bash)", "text", "solo(task)", "text", "group(read)"]);
  });

  // 되살리기 경로는 스트리밍과 다른 코드다. 세션을 다시 열면 이쪽이 그리므로
  // 같은 배치가 나와야 한다 — 안 그러면 껐다 켤 때마다 순서가 달라진다.
  test("되살린 히스토리도 같은 순서로 갈라진다", () => {
    const { self, children } = harness();
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        say("머리말."),
        call("bash", { command: "bun test" }),
        call("read", { path: "a.ts" }),
        say("첫 번째 확인했어."),
        call("grep", { pattern: "x" }),
        say("두 번째도 됐어."),
      ],
    };

    const rendered: any[] = [];
    self.addMessageToChat = (m: any) => {
      rendered.push(m);
      self.chatContainer.addChild(mark(m));
    };
    self.createToolExecutionComponent = (name: string, _id: string, args: any) => toolComponent(name, args);
    self.clearPendingTools = () => self.pendingTools.clear();
    self.settingsManager = { getShowCacheMissNotices: () => false };
    self.session = { modelRuntime: undefined };

    replayHistory(self, message);

    expect(shape(children)).toEqual([
      "text",
      "group(bash,read)",
      "text",
      "group(grep)",
      "text",
    ]);
    // 머리말과 두 중간 런이 각각 한 번씩만 그려진다.
    expect(rendered.map((m) => m.content.map((c: any) => c.text).join(""))).toEqual([
      "머리말.",
      "첫 번째 확인했어.",
      "두 번째도 됐어.",
    ]);
  });

  // 꼬리표(stopReason)는 딱 한 번, 그리고 시간상 마지막 자리에 나와야 한다.
  // 머리말에 달아두면 "출력이 잘렸다" 가 도구들보다 위에 나온다.
  test("꼬리표는 마지막 조각이 한 번만 진다", () => {
    const collect = (message: any) => {
      const { self } = harness();
      const rendered: any[] = [];
      self.addMessageToChat = (m: any) => {
        rendered.push(m);
        self.chatContainer.addChild(mark(m));
      };
      self.createToolExecutionComponent = (name: string, _id: string, args: any) => toolComponent(name, args);
      self.clearPendingTools = () => self.pendingTools.clear();
      self.settingsManager = { getShowCacheMissNotices: () => false };
      self.session = { modelRuntime: undefined };
      replayHistory(self, message);
      return rendered.map((m) => m.stopReason);
    };

    // 말로 끝나면 그 마지막 말이 꼬리표를 진다.
    expect(
      collect({
        role: "assistant",
        stopReason: "length",
        content: [say("머리말."), call("bash", { command: "a" }), say("중간말."), call("read", { path: "b" }), say("끝말.")],
      }),
    ).toEqual(["stop", "stop", "length"]);

    // 도구로 끝나면 받을 말 조각이 머리말뿐이다.
    expect(
      collect({
        role: "assistant",
        stopReason: "length",
        content: [say("머리말."), call("bash", { command: "a" })],
      }),
    ).toEqual(["length"]);

    // 도구가 아예 없으면 메시지를 그대로 그린다.
    expect(collect({ role: "assistant", stopReason: "length", content: [say("말만.")] })).toEqual(["length"]);
  });
});
