// 설치된 벤더 파일에서 pristine / patched 두 상태를 뽑는 테스트 헬퍼.
// 동등성 계약: 패치를 load transform 으로 옮겼으면 transform(pristine) 이
// patched 바이트와 같아야 한다 (재설계한 경우만 예외이며 테스트에 사유를 적는다).
//
// postinstall 의 locateInStack 역적용 round-trip 을 그대로 쓰므로 네트워크도
// tarball 도 필요 없다. 설치본이 series 와 안 맞으면 null 을 돌려준다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VENDOR_PATCHES,
  collectPatchLayers,
  locateInStack,
  stackByFile,
} from "../../../../../postinstall.mjs";

export const ALIASES = { senpi: 0, "senpi-tui": 1, "pi-ai": 2, "senpi-codemode": 3 };

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..");

/**
 * @param {keyof typeof ALIASES} alias
 * @param {string} relativePath  벤더 패키지 루트 기준 경로 (예: "dist/modes/interactive/components/tool-group.js")
 * @returns {{ pristine: string, patched: string, applied: number } | null}
 */
export function vendorFileStates(alias, relativePath) {
  const index = ALIASES[alias];
  if (index === undefined) throw new Error(`unknown vendor alias: ${alias}`);
  const spec = VENDOR_PATCHES[index];
  const root = spec.resolveRoot();
  const patched = readFileSync(join(root, relativePath), "utf8");
  const stack = stackByFile(collectPatchLayers(spec, repoRoot)).get(relativePath);
  if (!stack) return { pristine: patched, patched, applied: 0 };
  const located = locateInStack(patched, stack);
  if (!located) return null;
  return { pristine: located.pristine, patched, applied: located.applied };
}
