import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";
import { dispatchInternalAction, registerInternalAction } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/internal-actions.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { AssistantMessageComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

const ui = { requestRender() {} } as any;
const osc8Url = (lines: string[]) => lines.join("\n").match(/\x1b\]8;;([^\x1b\x07]+)/)?.[1];

describe("Senpi local collapse patch", () => {
  test("internal actions dispatch without treating unknown URLs as internal", () => {
    let calls = 0;
    const action = registerInternalAction(() => calls++);
    expect(dispatchInternalAction("https://example.com")).toBe(false);
    expect(dispatchInternalAction(action.url)).toBe(true);
    expect(calls).toBe(1);
    action.dispose();
    expect(dispatchInternalAction(action.url)).toBe(true);
    expect(calls).toBe(1);
  });

  test("a collapsed tool shows its own renderer output, not just the tool name", () => {
    const component = new ToolExecutionComponent("bash", "tool-1", { command: "printf hello" }, {}, undefined, ui, process.cwd());
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details: {}, isError: false });

    const collapsed = component.render(80);
    expect(collapsed).toHaveLength(1);
    // Collapsed line must be the tool's own renderCall output (the command), not a bare "bash" label.
    expect(stripAnsi(collapsed.join("\n"))).toContain("printf hello");
    const url = osc8Url(collapsed);
    expect(url).toStartWith("senpi-action:");

    dispatchInternalAction(url!);
    const expanded = stripAnsi(component.render(80).join("\n"));
    expect(expanded).toContain("printf hello");
    expect(expanded.length).toBeGreaterThan(collapsed.join("\n").length);
    dispatchInternalAction(url!);
    expect(component.render(80)).toHaveLength(1);
    component.dispose();
  });

  test("an errored tool collapses to exactly 2 lines with the error tail visible", () => {
    const component = new ToolExecutionComponent("bash", "tool-err", { command: "false" }, {}, undefined, ui, process.cwd());
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: "boom: something went wrong" }], details: {}, isError: true });

    const collapsed = component.render(80);
    expect(collapsed).toHaveLength(2);
    const text = stripAnsi(collapsed.join("\n"));
    expect(text).toContain("false");
    expect(text).toContain("boom: something went wrong");
    component.dispose();
  });

  test("SKILL.md read 는 접혀도 [skill] 이름처럼 보인다", async () => {
    const { createReadToolDefinition } = await import("../node_modules/@code-yeongyu/senpi/dist/core/tools/read.js");
    const definition = createReadToolDefinition(process.cwd());
    const component = new ToolExecutionComponent(
      "read",
      "tool-skill",
      { path: "/Users/wy/.agents/skills/keep-simple/SKILL.md" },
      {},
      definition,
      ui,
      process.cwd(),
    );
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: "# Keep Simple\nDo less." }], details: {}, isError: false });

    const collapsed = component.render(80);
    const text = stripAnsi(collapsed.join("\n"));
    expect(text).toContain("[skill]");
    expect(text).toContain("keep-simple");
    expect(text).not.toContain("Do less.");
    expect(text).not.toMatch(/\bread\b/);
    component.dispose();
  });

  test("todo renders fully expanded with no toggle needed", () => {
    const component = new ToolExecutionComponent(
      "todo",
      "tool-todo",
      { op: "write", tasks: [{ id: "1", title: "Do the thing", status: "pending" }] },
      {},
      undefined,
      ui,
      process.cwd(),
    );
    component.setArgsComplete();
    component.updateResult({
      content: [{ type: "text", text: "Do the thing" }],
      details: { phases: [], op: "write" },
      isError: false,
    });

    const rendered = component.render(80);
    const text = stripAnsi(rendered.join("\n"));
    // Full content is visible without any click/toggle, and there's no hyperlink to toggle it.
    expect(text).toContain("Do the thing");
    expect(osc8Url(rendered)).toBeUndefined();
    component.dispose();
  });

  test("task renders fully expanded with no toggle needed", () => {
    const component = new ToolExecutionComponent("task", "tool-task", { description: "spawn a subtask" }, {}, undefined, ui, process.cwd());
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: "subtask output line one\nline two" }], details: {}, isError: false });

    const rendered = component.render(80);
    const text = stripAnsi(rendered.join("\n"));
    expect(text).toContain("line two");
    expect(osc8Url(rendered)).toBeUndefined();
    component.dispose();
  });

  test("thinking is compact by default and toggles only its component", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 1,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as any;
    const first = new AssistantMessageComponent(message, true);
    const second = new AssistantMessageComponent(message, true);

    const collapsed = first.render(80);
    expect(stripAnsi(collapsed.join("\n"))).toContain("Thinking...");
    expect(stripAnsi(collapsed.join("\n"))).not.toContain("private reasoning");
    const url = osc8Url(collapsed)!;
    dispatchInternalAction(url);
    expect(stripAnsi(first.render(80).join("\n"))).toContain("private reasoning");
    expect(stripAnsi(second.render(80).join("\n"))).not.toContain("private reasoning");
    dispatchInternalAction(url);
    expect(stripAnsi(first.render(80).join("\n"))).not.toContain("private reasoning");
    first.dispose();
    second.dispose();
  });
});
