import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CLAUDE_ACCOUNT_ENV, CLAUDE_SETUP_TOKEN_FILE_ENV } from "../../src/anthropic-setup-token.mjs";

// cutover manifest 의 호환 창구: 예전 `FX_*` 변수는 canonical 변수가 없을 때만 읽고 한 번
// 경고한다. 모든 배포 대상이 새 이름을 쓰면 fallback 을 제거한다.
//
// 이것을 시험으로 막는 이유는 **두 쪽이 다른 계정을 볼 수 있었기** 때문이다.
// `anthropic-setup-token.mjs` 는 `RUBATO_CLAUDE_*` 를 읽는데 `rubato-auth.sh` 는 legacy
// `FX_CLAUDE_*` 만 읽고 있었다. 그래서 정식 이름을 설정한 사람에게 진단 스크립트가 엉뚱한
// 계정 상태를 보고했다. 이름이 갈리는 자리는 조용히 깨지므로 여기서 고정한다.

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, "..", "..", "..", "scripts");

/**
 * 스크립트의 계정 해석 줄만 떼어 실제로 실행한다.
 *
 * 전체를 source 하면 진단 본문이 같이 돌고 `ACCOUNT` 를 읽을 수 없다. 그래서 해석 줄을
 * 파일에서 **그대로 꺼내** 돌린다 — 문자열을 다시 적으면 스크립트가 바뀌어도 시험은 옛
 * 규칙을 계속 통과시킨다.
 */
function resolvedAccount(env) {
  const script = readFileSync(join(scriptsDir, "rubato-auth.sh"), "utf8");
  const lines = script.split("\n").filter((line) => /^(ACCOUNT|TOKEN_FILE)=/.test(line));
  assert.equal(lines.length, 2, `해석 줄을 찾지 못했다: ${JSON.stringify(lines)}`);
  const out = execFileSync("bash", ["-c", `set -eu\n${lines.join("\n")}\nprintf '%s\\n' "$ACCOUNT"`], {
    encoding: "utf8",
    env: { HOME: "/tmp/legacy-env-window-home", PATH: process.env.PATH, ...env },
  });
  return out.trim();
}

test("canonical 이름이 legacy 를 이긴다", () => {
  const account = resolvedAccount({ [CLAUDE_ACCOUNT_ENV]: "canon", FX_CLAUDE_ACCOUNT: "legacy" });
  assert.equal(account, "canon", "정식 이름을 설정했는데 legacy 가 이겼다");
});

test("canonical 이 없으면 legacy 를 계속 읽는다", () => {
  // 배포 대상이 다 옮겨질 때까지 이것이 동작해야 한다. 지금 끊으면 예전 이름만 둔 기기가
  // 조용히 기본 계정으로 떨어진다.
  const account = resolvedAccount({ FX_CLAUDE_ACCOUNT: "legacy" });
  assert.equal(account, "legacy");
});

test("둘 다 없으면 기본 계정이다", () => {
  assert.equal(resolvedAccount({}), "sub");
});

test("설정 스크립트와 직결 경로가 같은 이름을 쓴다", () => {
  // 두 쪽이 다른 이름을 읽으면 진단이 실제 세션과 다른 계정을 보고한다. 그것이 실제로
  // 일어났던 결함이다.
  const script = execFileSync("cat", [join(scriptsDir, "rubato-auth.sh")], { encoding: "utf8" });
  assert.match(script, new RegExp(CLAUDE_ACCOUNT_ENV), `rubato-auth.sh 가 ${CLAUDE_ACCOUNT_ENV} 를 읽지 않는다`);
  assert.match(
    script,
    new RegExp(CLAUDE_SETUP_TOKEN_FILE_ENV),
    `rubato-auth.sh 가 ${CLAUDE_SETUP_TOKEN_FILE_ENV} 를 읽지 않는다`,
  );
});
