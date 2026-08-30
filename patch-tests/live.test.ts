import { expect, test } from "bun:test";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { ToolGroupComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-group.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
initTheme("dark", false);

test("실행 중 숫자가 1 tool → 2 tools 로 올라간다", () => {
  let renders = 0;
  const ui = { requestRender() { renders++; } } as any;
  const g = new ToolGroupComponent(ui);
  const line = () => stripAnsi(g.render(92).join(""));
  const seen: string[] = [];

  const mk = (n: string, a: any) => {
    const c = new ToolExecutionComponent(n, "t" + Math.random(), a, {}, undefined, ui, process.cwd());
    c.setArgsComplete(); c.markExecutionStarted();
    return c;
  };

  // 1개 시작
  const t1 = mk("ls", { path: "." });
  g.addTool(t1);
  seen.push(line());
  expect(line()).toContain("• 1 tool");
  expect(line()).not.toContain("⋯");
  expect(line()).not.toContain("1 tools");

  // 끝남 -> 줄 수 붙음
  t1.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], details: {}, isError: false });
  g.refresh();
  seen.push(line());
  expect(line()).toContain("tool");

  // 2개째 시작 -> 숫자 오르고 줄 수는 잠시 사라짐(진행 중)
  const t2 = mk("read", { path: "a.ts" });
  g.addTool(t2);
  seen.push(line());
  expect(line()).toContain("2 tools");
  expect(line()).toContain("tools");

  t2.updateResult({ content: [{ type: "text", text: "x\ny" }], details: {}, isError: false });
  g.refresh();
  seen.push(line());
  expect(line()).toContain("2 tools");
  expect(line()).toContain("tool");

  expect(renders).toBeGreaterThan(0);
  for (const s of seen) console.log("  " + JSON.stringify(s));
  g.dispose();
});
