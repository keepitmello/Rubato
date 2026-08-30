import { test } from "bun:test";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";
import { createAllToolDefinitions } from "../node_modules/@code-yeongyu/senpi/dist/core/tools/index.js";
import { ToolExecutionComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js";
import { ToolGroupComponent } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/tool-group.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

initTheme("dark", false);
const ui = { requestRender() {} } as any;

// 진짜 edit 를 돌려 진짜 details.patch 를 얻는다.
const dir = mkdtempSync(join(tmpdir(), "e-"));
const f = join(dir, "a.ts");
writeFileSync(f, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
const defs = createAllToolDefinitions(dir);
const editResult: any = await defs.edit.execute(
  "c1",
  { path: f, edits: [{ oldText: "line 3\nline 4\nline 5", newText: "NEW A\nNEW B" }] },
  undefined,
  undefined,
  {} as any,
);

function mk(name: string, args: any, result: any) {
  const c = new ToolExecutionComponent(name, "t" + Math.random(), args, {}, undefined, ui, process.cwd());
  c.setArgsComplete();
  c.updateResult(result);
  return c;
}

test("edit 는 증감이 초록/빨강으로 붙고, 줄 수는 안 붙는다", () => {
  const g = new ToolGroupComponent(ui);
  g.addTool(mk("ls", { path: "." }, { content: [{ type: "text", text: "a\nb\nc" }], details: {}, isError: false }));
  g.addTool(mk("edit", { path: f }, { content: editResult.content, details: editResult.details, isError: false }));

  const raw = g.render(92).join("");
  const text = stripAnsi(raw);
  console.log("  실제 →", JSON.stringify(text));

  // 증감이 보인다
  if (!/\+\d+/.test(text) || !/-\d+/.test(text)) throw new Error("증감이 없다: " + text);
  // 초록/빨강이 실제로 입혀졌다
  if (!raw.includes("\x1b[38;2;122;162;122m")) throw new Error("추가 초록 없음");
  if (!raw.includes("\x1b[38;2;196;116;110m")) throw new Error("삭제 빨강 없음");
  // 숨긴 줄 수는 더 이상 적지 않는다
  if (text.includes("lines")) throw new Error("lines 가 남아있다: " + text);
  g.dispose();
});
