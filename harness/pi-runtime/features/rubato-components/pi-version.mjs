import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * 스톡 Pi 핀의 단일 출처. `resolve-runtime.mjs` 와 feature 가 `../../pi-version.mjs`
 * 를 통해 여기로 온다.
 *
 * 이 상수를 각자 리터럴로 들고 있으면 핀을 올릴 때 조용히 어긋나고, stage 가
 * 첫 패치를 만지기 전에 죽는다 — `resolve-runtime.mjs` 의 PI_VERSION 은
 * PI_RUNTIME_VERSION_MISMATCH 를, feature 의 `files[].version` 은
 * `file.version !== source.version` (stage-runtime.mjs) 을 낸다.
 * 2026-09-20 에 0.85.1 → 0.86.1 을 올리며 두 곳 모두 실측했다.
 *
 * 이 파일은 payload 로 **staged 후보 안에도 복사된다.** 후보 루트가 레포의
 * `harness/pi-runtime/` 과 같은 깊이에 서므로 두 레이아웃에서 상대 위치가 같고,
 * 그래서 자기 위치에서 위로 올라가며 핀을 선언한 `package.json` 을 찾는 방식이
 * 양쪽에서 같은 답을 낸다 (레포: `harness/pi-runtime/package.json`,
 * 후보: 후보 루트의 `package.json`).
 */
function findPinnedVersion(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pinned = JSON.parse(readFileSync(candidate, "utf8"))?.dependencies?.[PINNED_PACKAGE];
        if (typeof pinned === "string" && pinned.trim() !== "") return pinned.trim().replace(/^[\^~>=<\s]+/, "");
      } catch {
        // 깨진 매니페스트는 건너뛰고 계속 올라간다.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json declaring ${PINNED_PACKAGE} above ${startDir}`);
    dir = parent;
  }
}

export const PI_VERSION = findPinnedVersion(dirname(fileURLToPath(import.meta.url)));
