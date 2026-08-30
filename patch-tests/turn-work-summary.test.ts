import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";
import { AssistantMessageComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { ToolGroupComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-group.js";
import { TurnWorkSummaryComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/turn-work-summary.js";
import { dispatchInternalAction } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/internal-actions.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);
const ui = { requestRender() {} } as any;
const actionUrl = (lines: string[]) => lines.join("\n").match(/\x1b\]8;;([^\x1b\x07]+)/)?.[1];

function tool(id: number) {
  const component = new ToolExecutionComponent("read", `t${id}`, { path: `f${id}` }, {}, undefined, ui, process.cwd());
  component.setArgsComplete();
  component.updateResult({ content: [{ type: "text", text: `result-${id}` }], details: {}, isError: false });
  return component;
}

function failedTool(id: number) {
  const component = new ToolExecutionComponent("bash", `e${id}`, { command: "bun test" }, {}, undefined, ui, process.cwd());
  component.setArgsComplete();
  component.updateResult({ content: [{ type: "text", text: "FAIL" }], details: {}, isError: true });
  return component;
}

describe("턴 작업 요약", () => {
  test("스트리밍 head와 꼬리 segment가 같은 사고를 중복 소유하지 않는다", () => {
    const source = readFileSync(
      join(import.meta.dir, "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js"),
      "utf8",
    );
    const tracked = source.match(/trackAssistant\(this\.streamingComponent, assistantStreamingHeadMessage\(event\.message\)\)/g) ?? [];
    expect(tracked).toHaveLength(2);
    expect(source).not.toContain("trackAssistant(this.streamingComponent, event.message)");
    expect(source).toContain("this.startTurnWorkSummary();\n                    this.streamingComponent");
    const agentEnd = source.slice(source.indexOf('case "agent_end"'), source.indexOf('case "agent_settled"'));
    expect(agentEnd).toContain("this.closeToolGroup()");
    expect(agentEnd).not.toContain("this.turnWorkSummary = undefined");
  });

  test("진행 중에도 사고와 도구를 한 줄로 접고 클릭할 때만 펼친다", () => {
    const startedAt = Date.now() - 47_000;
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "숨긴 사고", startedAt, endedAt: startedAt + 47_000 }],
      timestamp: startedAt,
      stopReason: "stop",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);
    const tools = new ToolGroupComponent(ui);
    for (let i = 0; i < 15; i++) tools.addTool(tool(i));
    tools.addTool(failedTool(1));
    const summary = new TurnWorkSummaryComponent(ui);
    summary.trackAssistant(assistant, message);
    summary.trackToolGroup(tools);

    expect(assistant.render(100)).toEqual([]);
    expect(tools.render(100)).toEqual([]);
    const collapsed = summary.render(100);
    const collapsedText = stripAnsi(collapsed.join(""));
    expect(collapsedText).toContain("• Worked 1 step · thought 47s · 16 tools:");
    expect(collapsedText).toContain("✓ read (15)");
    expect(collapsedText).toContain("✗ bash");
    expect(collapsed.join("")).not.toContain("38;2;196;116;110");
    expect(stripAnsi(collapsed.join(""))).not.toStartWith("...");

    dispatchInternalAction(actionUrl(collapsed)!);
    expect(stripAnsi(assistant.render(100).join("\n"))).toContain("Thought: 47.0s");
    expect(stripAnsi(tools.render(100).join("\n"))).toContain("16 tools");

    dispatchInternalAction(actionUrl(collapsed)!);
    expect(assistant.render(100)).toEqual([]);
    expect(tools.render(100)).toEqual([]);
    summary.dispose();
    tools.dispose();
    assistant.dispose();
  });

  test("GPT tool-use ellipsis filler never becomes a visible assistant block", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "사용자에게 보일 진행 설명...." },
        { type: "toolCall", id: "gpt-tool", name: "read", arguments: { path: "file.ts" } },
        { type: "text", text: "..." },
      ],
      timestamp: Date.now(),
      stopReason: "toolUse",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);
    const summary = new TurnWorkSummaryComponent(ui);
    summary.trackAssistant(assistant, message);

    const visible = stripAnsi(assistant.render(100).join("\n"));
    expect(visible).toContain("사용자에게 보일 진행 설명....");
    expect(visible.split("\n").map((line) => line.trim())).not.toContain("...");
    summary.dispose();
    assistant.dispose();
  });

  test("pending ellipsis is withheld before a tool arrives and restored for a final answer", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      timestamp: Date.now(),
      stopReason: "pending",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);

    expect(stripAnsi(assistant.render(100).join("\n")).split("\n").map((line) => line.trim())).not.toContain("...");

    message.stopReason = "stop";
    assistant.updateContent(message, false);
    expect(stripAnsi(assistant.render(100).join("\n"))).toContain("...");
    assistant.dispose();
  });

  test("pending ellipsis stays hidden after a tool arrives", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "pending-tool", name: "read", arguments: { path: "file.ts" } },
        { type: "text", text: "..." },
      ],
      timestamp: Date.now(),
      stopReason: "pending",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);

    expect(stripAnsi(assistant.render(100).join("\n")).split("\n").map((line) => line.trim())).not.toContain("...");
    assistant.dispose();
  });

  test("ellipsis remains visible when it is a final answer rather than tool-use filler", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      timestamp: Date.now(),
      stopReason: "stop",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);

    expect(stripAnsi(assistant.render(100).join("\n"))).toContain("...");
    assistant.dispose();
  });

  test("사용자에게 보일 답변은 요약 밖에 그대로 남는다", () => {
    const startedAt = Date.now() - 2_000;
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "숨긴 사고", startedAt, endedAt: startedAt + 2_000 },
        { type: "text", text: "사용자에게 보일 답변" },
      ],
      timestamp: startedAt,
      stopReason: "stop",
    } as any;
    const assistant = new AssistantMessageComponent(message, true);
    const summary = new TurnWorkSummaryComponent(ui);
    summary.trackAssistant(assistant, message);

    const visible = stripAnsi(assistant.render(100).join("\n"));
    expect(visible).toContain("사용자에게 보일 답변");
    expect(visible).not.toContain("Thought:");
    expect(visible).not.toContain("숨긴 사고");
    summary.dispose();
    assistant.dispose();
  });

  test("도구 종류가 많아도 접힌 불릿은 주어진 폭을 넘지 않는다", () => {
    const tools = new ToolGroupComponent(ui);
    for (let i = 0; i < 20; i++) {
      const component = new ToolExecutionComponent(`tool-${i}`, `w${i}`, {}, {}, undefined, ui, process.cwd());
      component.setArgsComplete();
      component.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false });
      tools.addTool(component);
    }
    const summary = new TurnWorkSummaryComponent(ui);
    summary.trackToolGroup(tools);
    const line = stripAnsi(summary.render(60).join(""));
    expect([...line].length).toBeLessThanOrEqual(60);
    expect(line).toStartWith("• Worked 0 steps · 20 tools:");
    expect(line).toContain("…+");
    summary.dispose();
    tools.dispose();
  });
});
