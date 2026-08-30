// 벤더 패치를 기능 단위로 쌓는 구조의 계약.
//
// 통짜 패치 하나를 계속 재생성하던 시절에 잃은 것 셋이 이 구조를 만든 이유다:
// 재생성이 남의 hunk 를 덮었고, 사람이 파일 목록을 고르다 신규 파일이 빠졌고,
// 두 세션이 같은 패치 파일을 동시에 써서 하나가 조용히 사라졌다.
//
// 여기서 지키는 것은 넷이다: 순서가 결정적이다, 부분 적용 상태를 정확히 짚는다,
// 겹치는 patch 는 조용히 넘어가지 않고 멈춘다, 버전이 다르면 억지로 대지 않는다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFilePatch,
  assertExpectedVersion,
  collectPatchLayers,
  locateInStack,
  seriesDir,
  stackByFile,
} from "../postinstall.mjs";

const spec = {
  packageName: "fixture-pkg",
  patchName: "fixture%2Fpkg@1.0.0.patch",
  seriesName: "fixture%2Fpkg",
  expectedVersion: "1.0.0",
};

/** `-old +new` 한 줄짜리 patch. context 없이 그 줄만 바꾼다. */
function linePatch(relativePath: string, before: string, after: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    "@@ -1,1 +1,1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

function newFilePatch(relativePath: string, contents: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    "@@ -0,0 +1,1 @@",
    `+${contents}`,
    "",
  ].join("\n");
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vendor-series-"));
  mkdirSync(join(root, "patches"), { recursive: true });
  writeFileSync(join(root, "patches", spec.patchName), linePatch("dist/a.js", "pristine", "baseline"));
  mkdirSync(seriesDir(spec, root), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function addSeries(name: string, text: string) {
  writeFileSync(join(seriesDir(spec, root), name), text);
}

describe("순서", () => {
  test("baseline 이 먼저고 series 는 파일명 오름차순이다", () => {
    // 명시적 index 파일을 두지 않는 것이 요점이다 — 그건 다시 모두가 함께 쓰는
    // 파일이 되어 우리가 없앤 경합을 되살린다.
    addSeries("20260824-0002-second.patch", linePatch("dist/a.js", "second-in", "second-out"));
    addSeries("20260824-0001-first.patch", linePatch("dist/a.js", "first-in", "first-out"));
    const layers = collectPatchLayers(spec, root);
    expect(layers.map((layer) => layer.name)).toEqual([
      spec.patchName,
      "fixture%2Fpkg/1.0.0/20260824-0001-first.patch",
      "fixture%2Fpkg/1.0.0/20260824-0002-second.patch",
    ]);
  });

  test(".patch 가 아닌 것은 series 에 들지 않는다", () => {
    addSeries("notes.md", "# 이건 patch 가 아니다\n");
    expect(collectPatchLayers(spec, root).length).toBe(1);
  });

  test("한 파일에 걸리는 층이 순서대로 쌓인다", () => {
    addSeries("20260824-0001-a.patch", linePatch("dist/a.js", "baseline", "one"));
    addSeries("20260824-0002-b.patch", newFilePatch("dist/new.js", "brand new"));
    const stacks = stackByFile(collectPatchLayers(spec, root));
    expect(stacks.get("dist/a.js")?.length).toBe(2);
    expect(stacks.get("dist/new.js")?.length).toBe(1);
    expect(stacks.get("dist/new.js")?.[0].createsFile).toBe(true);
  });
});

describe("부분 적용 상태", () => {
  test("어디까지 적용됐는지 마커 없이 짚는다", () => {
    addSeries("20260824-0001-a.patch", linePatch("dist/a.js", "baseline", "one"));
    const stack = stackByFile(collectPatchLayers(spec, root)).get("dist/a.js")!;
    expect(locateInStack("pristine\n", stack)?.applied).toBe(0);
    expect(locateInStack("baseline\n", stack)?.applied).toBe(1);
    expect(locateInStack("one\n", stack)?.applied).toBe(2);
  });

  test("신규 파일은 완성본을 다시 원본으로 오인해 덧붙이지 않는다", () => {
    addSeries("20260824-0001-new.patch", newFilePatch("dist/new.js", "brand new"));
    const stack = stackByFile(collectPatchLayers(spec, root)).get("dist/new.js")!;
    expect(locateInStack("", stack)?.applied).toBe(0);
    expect(locateInStack("brand new\n", stack)?.applied).toBe(1);
    expect(locateInStack("brand new\nbrand new\n", stack)).toBeNull();
  });

  test("손으로 고친 파일은 pristine 으로 오인되더라도 적용 단계에서 걸린다", () => {
    // 진짜 pristine 이 어떤 바이트였는지는 아무도 들고 있지 않다. 그래서 낯선
    // 내용은 일단 "아무것도 적용 안 된 상태"로 보이는데, 그 위에 baseline 을
    // 대는 순간 hunk 가 안 맞아 멈춘다. 조용히 덮지 않는 것이 요점이다.
    addSeries("20260824-0001-a.patch", linePatch("dist/a.js", "baseline", "one"));
    const stack = stackByFile(collectPatchLayers(spec, root)).get("dist/a.js")!;
    const edited = "someone edited node_modules by hand\n";
    const located = locateInStack(edited, stack)!;
    expect(located.applied).toBe(0);
    expect(() => applyFilePatch(located.pristine as string, stack[0], stack[0].patchName)).toThrow(/cannot apply/);
  });
});

describe("겹치는 patch", () => {
  test("같은 줄을 건드리는 두 patch 는 조용히 넘어가지 않는다", () => {
    addSeries("20260824-0001-a.patch", linePatch("dist/a.js", "baseline", "changed by A"));
    addSeries("20260824-0002-b.patch", linePatch("dist/a.js", "baseline", "changed by B"));
    const stack = stackByFile(collectPatchLayers(spec, root)).get("dist/a.js")!;
    const located = locateInStack("pristine\n", stack)!;
    expect(located.applied).toBe(0);

    let contents = located.pristine as string;
    const apply = () => {
      for (const filePatch of stack) {
        contents = applyFilePatch(contents, filePatch, filePatch.patchName) as string;
      }
    };
    // 자동 병합은 하지 않는다. 마지막 저장자 승리보다 명시적 실패가 낫다.
    expect(apply).toThrow(/cannot apply/);
  });

  test("서로 다른 파일을 건드리면 나란히 적용된다", () => {
    addSeries("20260824-0001-a.patch", linePatch("dist/a.js", "baseline", "changed by A"));
    addSeries("20260824-0002-b.patch", newFilePatch("dist/b.js", "made by B"));
    const stacks = stackByFile(collectPatchLayers(spec, root));
    for (const [relativePath, stack] of stacks) {
      const source = relativePath === "dist/a.js" ? "pristine\n" : "";
      const located = locateInStack(source, stack)!;
      let contents = located.pristine as string;
      for (const filePatch of stack) contents = applyFilePatch(contents, filePatch, filePatch.patchName) as string;
      expect(contents).toBe(relativePath === "dist/a.js" ? "changed by A\n" : "made by B\n");
    }
  });
});

describe("버전", () => {
  test("설치된 버전이 다르면 억지로 대지 않는다", () => {
    expect(() => assertExpectedVersion(spec, "1.0.1")).toThrow(/targets 1\.0\.0/);
    expect(() => assertExpectedVersion(spec, "1.0.0")).not.toThrow();
  });
});
