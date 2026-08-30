// 벤더 패치가 **실제로 도는 사본**에 살아 있는지 본다.
//
// pi-tui 는 두 벌 깔린다. 루트의 것과 senpi 가 자기 안에 품은 것이고,
// 세션이 읽는 것은 후자다. 이 구분을 놓쳐서 "패치는 정확한데 화면은 원본"인
// 상태가 오래 갔다 — 검증이 패치된 사본을 직접 열어보고 통과했기 때문이다.
//
// 마커를 손으로 고르지 않는다. baseline + series 스택을 역적용해서
// pristine 이 나오고, 다시 정적용했을 때 현재 바이트와 같으면 그 파일은
// 시리즈가 적용된 상태다. 패치가 한 장 더 쌓여도 이 테스트는 따라온다.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, stackByFile } from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");

for (const spec of VENDOR_PATCHES) {
  describe(spec.packageName, () => {
    const root = spec.resolveRoot();
    const stacks = stackByFile(collectPatchLayers(spec, repoRoot));
    for (const [relativePath, stack] of stacks) {
      test(`${relativePath} 에 시리즈가 살아 있다`, () => {
        const targetPath = join(root, relativePath);
        expect(existsSync(targetPath)).toBe(true);
        const patched = readFileSync(targetPath, "utf8");
        const located = locateInStack(patched, stack);
        expect(located).not.toBeNull();
        expect(located?.applied).toBe(stack.length);
      });
    }
    test("realpath 가 같은 사본을 본다", () => {
      expect(realpathSync(root)).toBe(realpathSync(spec.resolveRoot()));
    });
  });
}
