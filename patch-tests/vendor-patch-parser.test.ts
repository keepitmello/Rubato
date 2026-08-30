// 벤더 패치가 조용히 사라지던 두 경로를 막는다.
// 둘 다 실제로 겪었다: hunk 하나가 헤더 없이 붙어 통째로 무시됐고,
// 그 사실이 에러 없이 지나갔다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFilePatch, parseFilePatches } from "../postinstall.mjs";

const patchesDir = join(import.meta.dir, "..", "patches");
const senpiPatch = readFileSync(join(patchesDir, "@code-yeongyu%2Fsenpi@2026.8.22.patch"), "utf8");
const tuiPatch = readFileSync(join(patchesDir, "@code-yeongyu%2Fsenpi-tui@2026.8.22.patch"), "utf8");

/** 패치를 파일별 chunk 로 자른다. 픽스처를 조립할 때 쓴다. */
function chunksOf(patchText: string): string[] {
  return patchText.split(/(?=^diff --git )/m).filter((c) => c.startsWith("diff --git "));
}

describe("실제 패치", () => {
  test("senpi 패치의 모든 파일이 파싱된다", () => {
    const files = parseFilePatches(senpiPatch, "senpi");
    expect(files.length).toBe(chunksOf(senpiPatch).length);
    expect(files.map((f) => f.relativePath)).toContain("dist/modes/interactive/components/tool-group.js");
  });

  test("tui 패치의 모든 파일이 파싱된다", () => {
    const files = parseFilePatches(tuiPatch, "tui");
    expect(files.length).toBe(chunksOf(tuiPatch).length);
  });
});

describe("조용히 사라지던 형식", () => {
  test("헤더 없이 붙은 hunk 는 통과하지 못한다", () => {
    const [first, second] = chunksOf(senpiPatch);
    // 두 번째 파일에서 `diff --git` 줄만 떼어 앞 chunk 에 붙인다.
    const glued = `${first.trimEnd()}\n${second.split("\n").slice(1).join("\n")}`;
    // 파싱은 통과한다 — 헤더가 하나뿐이니 chunk 도 하나다.
    // 손실은 적용 단계에서 잡혀야 한다.
    const [filePatch] = parseFilePatches(glued, "glued");
    expect(() => applyFilePatch("", filePatch, "glued")).toThrow(/diff --git/);
  });

  test("hunk 가 없는 diff 는 거부된다", () => {
    const modeOnly = "diff --git a/dist/x.js b/dist/x.js\nold mode 100644\nnew mode 100755\n";
    expect(() => parseFilePatches(modeOnly, "mode-only")).toThrow(/no hunks/);
  });

  test("rename 은 거부된다", () => {
    const renamed = "diff --git a/dist/x.js b/dist/y.js\n--- a/dist/x.js\n+++ b/dist/y.js\n@@ -1 +1 @@\n-a\n+b\n";
    expect(() => parseFilePatches(renamed, "rename")).toThrow(/rename|malformed/);
  });
});
