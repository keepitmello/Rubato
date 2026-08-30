import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// "좌석"/"seat" 은어를 막는다.
//
// 이 은어는 세 번 좀비로 살아났고, 마지막 원인은 문서가 아니라 코드였다:
// 디렉토리가 seats/, 함수가 seatNameForRole 이면 한국어 문서를 쓸 때마다
// "좌석" 이 재생산된다. 이름을 바꾼 김에 그 자리를 테스트로 막는다.
//
// 가리키는 대상은 "역할별 시스템 프롬프트" 다. 그대로 부르면 된다.
//
// 예외는 은어 금지 자체를 서술하는 이 테스트와 배포용 스킬 사본뿐이다.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

const ALLOWED = [
  "test/unit/no-seat-jargon.test.mjs",
  // harness/skills/ 는 ~/.agents/skills 를 그대로 뜼는 배포용 사본이다(생성물).
  // 정본이 아니므로 여기서 고쳐도 다음 bundle-skills.sh 가 되돌린다.
  // 스킬 쪽 은어는 정본(agent-taskforce)에서 잡는다.
  "harness/skills/",
];

function search(pattern) {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-nI", "-e", pattern, "--", "harness/"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (error) {
    if (error.status === 1) return []; // no match
    throw error;
  }
}

function offenders(pattern) {
  return search(pattern).filter((line) => !ALLOWED.some((ok) => line.includes(ok)));
}

test("'좌석' 은어가 살아 있는 문서에 없다", () => {
  const hits = offenders("좌석");
  assert.deepEqual(
    hits,
    [],
    `"좌석" 대신 "역할별 시스템 프롬프트" 라고 쓴다. 발견:\n${hits.join("\n")}`,
  );
});

test("seat 식별자가 코드에 없다", () => {
  const hits = offenders("[Ss]eat");
  assert.deepEqual(
    hits,
    [],
    `seat/Seat 대신 rolePrompt 계열 이름을 쓴다. 발견:\n${hits.join("\n")}`,
  );
});
