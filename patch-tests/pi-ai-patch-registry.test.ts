// pi-ai patch 의 **포장**을 본다. 동작은 pi-ai-lazy-local-work.test.ts 가 본다.
//
// 이 patch 는 `VENDOR_PATCHES` 에 등록돼 있고, 따라서 `postinstall.mjs` 가 설치본에
// 적용한다. 여기서 지키는 것은 등록이 가리키는 자리가 **세션이 실제로 읽는 사본**
// 인지, 그리고 series 규약(이름·자리·파서·역적용 round-trip)이 맞는지다.
//
// baseline 을 상수 SHA 로 박지 않는다. 적용 뒤에는 설치본 바이트가 곧 patched 라
// 그런 상수는 활성화 순간 전부 거짓이 된다. 대신 등록된 스택을 **역적용**해서
// pristine 을 얻는다 — postinstall 이 부분 적용 상태를 짚을 때 쓰는 그 경로다.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  VENDOR_PATCHES,
  applyFilePatch,
  assertExpectedVersion,
  collectPatchLayers,
  locateInStack,
  parseFilePatches,
  seriesDir,
  stackByFile,
} from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const SERIES_NAME = "@earendil-works%2Fpi-ai";
const LAZY_REL = "dist/api/lazy.js";
const CURSOR_REL = "dist/api/cursor-agent.js";
const CURSOR_DTS_REL = "dist/api/cursor-agent.d.ts";
const TYPES_DTS_REL = "dist/types.d.ts";
/** 파일당 "적용됨"을 말해 주는 토큰. 상수 SHA 가 아니다 — 설치본은 이미 patched 다. */
const PATCHED_FILES = [
  [LAZY_REL, "setLocalWorkDelegate"],
  [CURSOR_REL, "cursorFailureDescriptor"],
  // JS 가 AssistantMessage 에 선언 없는 필드를 얹으면 그 필드는 타입에 존재하지 않는
  // 것이 된다. 소비자는 `as any` 로 읽게 되고, 그때 kind 오타는 컴파일에서 안 잡힌다.
  // 그래서 구조화된 계약은 선언 산출물에도 함께 들어간다.
  [CURSOR_DTS_REL, "cursorFailureDescriptor"],
  [TYPES_DTS_REL, "cursorFailure?"],
  // Cursor module-local state cleanup: session disposal hook + TTL/LRU bounds.
  ["dist/api/cursor-conversation-rotation.js", "forget(baseId)"],
  ["dist/api/cursor-conversation-rotation.d.ts", "forget(baseId: string)"],
  ["dist/utils/prompt-cache-ttl.js", "PROMPT_CACHE_TTL_GPT56_SECONDS"],
  ["dist/utils/prompt-cache-ttl.d.ts", "PROMPT_CACHE_TTL_GPT56_SECONDS"],
  ["dist/utils/overflow.js", "conversation is too long"],
] as const;

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === SERIES_NAME);

describe("@earendil-works/pi-ai vendor patch packaging", () => {
  test("canonical VENDOR_PATCHES 에 등록돼 있다", () => {
    expect(spec).toBeDefined();
    expect(spec!.patchName).toBe(`${SERIES_NAME}@${spec!.expectedVersion}.patch`);
    expect(existsSync(join(repoRoot, "patches", spec!.patchName))).toBe(true);
    expect(seriesDir(spec!, repoRoot)).toBe(join(repoRoot, "patches", SERIES_NAME, spec!.expectedVersion));
  });

  test("등록이 가리키는 자리가 세션이 실제로 읽는 nested 사본이다", () => {
    const root = spec!.resolveRoot();
    const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
    // 루트 hoist 사본이 아니라 senpi 안의 사본. engine-paths 의 senpiNested() 도 이쪽을 먼저 본다.
    expect(realpathSync(root)).toBe(realpathSync(join(senpiRoot, "node_modules/@earendil-works/pi-ai")));
    // 그리고 그 자리는 이 레포 안이어야 한다 — 심링크를 넘어 남의 설치본을 고치면 안 된다.
    expect(realpathSync(root).startsWith(realpathSync(repoRoot))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.name).toBe("@earendil-works/pi-ai");
    expect(manifest.version).toBe(spec!.expectedVersion);
    expect(() => assertExpectedVersion(spec!, manifest.version)).not.toThrow();
  });

  test("레포 파서로 읽히고 파일 하나만 건드린다", () => {
    const layers = collectPatchLayers(spec!, repoRoot);
    const stacks = stackByFile(layers);
    // baseline 은 동결이다. cursor-agent 는 series 로 붙어야 하며, 동결된 baseline 을
    // 재생성해 넣으면 남의 hunk 를 덮는 그 시절로 돌아간다.
    expect([...stacks.keys()].sort()).toEqual(PATCHED_FILES.map(([rel]) => rel).slice().sort());
    const filePatches = parseFilePatches(
      readFileSync(join(repoRoot, "patches", spec!.patchName), "utf8"),
      spec!.patchName,
    );
    expect(filePatches).toHaveLength(1);
    expect(filePatches[0].relativePath).toBe(LAZY_REL);
    expect(filePatches[0].createsFile).toBe(false);
  });

  test("설치본이 등록된 스택을 전부 적용한 상태다", () => {
    const stacks = stackByFile(collectPatchLayers(spec!, repoRoot));
    for (const [rel, marker] of PATCHED_FILES) {
      const stack = stacks.get(rel)!;
      const installed = readFileSync(join(spec!.resolveRoot(), rel), "utf8");
      const located = locateInStack(installed, stack);
      expect(located).not.toBeNull();
      expect(located!.applied).toBe(stack.length);
      expect(installed).toContain(marker);
    }
    // cursor-agent.js carries both layers: the failure discriminator and the
    // session-disposal cleanup. Assert the second explicitly so a regenerated
    // patch cannot quietly drop it.
    const cursorAgent = readFileSync(join(spec!.resolveRoot(), CURSOR_REL), "utf8");
    expect(cursorAgent).toContain("registerSessionResourceCleanup(disposeCursorSessionState)");
    expect(cursorAgent).toContain("enforceConversationStateBounds");
  });

  test("역적용으로 얻은 pristine 은 패치 토큰을 갖지 않고, 정적용하면 설치본 바이트로 정확히 돌아온다", () => {
    // pristine 을 상수로 두지 않는다. 스택을 되돌려 얻고, 다시 얹어 같은 바이트가
    // 나오는지 본다 — 이 round-trip 이 "적용됨"의 정의다.
    const stacks = stackByFile(collectPatchLayers(spec!, repoRoot));
    for (const [rel, marker] of PATCHED_FILES) {
      const stack = stacks.get(rel)!;
      const installed = readFileSync(join(spec!.resolveRoot(), rel), "utf8");
      const pristine = locateInStack(installed, stack)!.pristine;

      expect(pristine).not.toBe(installed);
      expect(pristine).not.toContain(marker);
      expect(locateInStack(pristine, stack)?.applied).toBe(0);

      let forward = pristine;
      for (const filePatch of stack) forward = applyFilePatch(forward, filePatch, filePatch.patchName) as string;
      expect(forward).toBe(installed);
    }
  });
});
