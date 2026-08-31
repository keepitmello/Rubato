import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgentDir, launchEnv } from "./brand.mjs";
import { ensureAgentExtensions } from "./agent-extensions.mjs";
import { PIN } from "./policy.mjs";
import { resolveRole } from "./role-contract.mjs";
import { listNodeCandidates, pickNode, runningNode } from "./select-node.mjs";
import { withNoChangelog } from "./no-changelog.mjs";
import { ensureSessionDefaults, sessionDefaultsLookCurrent } from "./session-defaults.mjs";
import { replaceSystemPrompt } from "./system-prompt.mjs";
import { SKILL_DIRS } from "./skills-section.mjs";
import { enginePackageJson, senpiCli, senpiPackageJson } from "./engine-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export function packageRoot() {
  return root;
}

export function senpiCliPath() {
  return senpiCli;
}

export function leadOverlayPath() {
  return join(root, "src/extensions/lead-overlay.mjs");
}

export function adapterPath() {
  return join(root, "src/extensions/adapter.mjs");
}

export function statuslinePath() {
  return join(root, "src/extensions/statusline.mjs");
}

export function providerOverlayPath() {
  return join(root, "src/extensions/provider-overlay.mjs");
}

export function readPinnedVersions() {
  const engine = JSON.parse(readFileSync(enginePackageJson, "utf8"));
  const senpi = JSON.parse(
    readFileSync(senpiPackageJson, "utf8"),
  );
  return { engine: engine.version, senpi: senpi.version };
}

export function assertExactPin() {
  const got = readPinnedVersions();
  if (got.engine !== PIN.engine || got.senpi !== PIN.senpi) {
    throw new Error(`rubato-pi pin mismatch: want ${PIN.engine}+${PIN.senpi}, got ${got.engine}+${got.senpi}`);
  }
}

export function resolveNode24() {
  const running = runningNode();
  if (running) return running;
  const picked = pickNode(listNodeCandidates(undefined, [process.execPath]));
  if (!picked) {
    throw new Error("rubato-pi needs Node.js 24+ already installed. Default Node was not changed.");
  }
  return picked;
}

// 시스템 프롬프트의 스킬 목록은 skills-section.mjs 가 SKILL_DIRS 를 직접 읽어
// 만든다. 그런데 senpi 자신의 레지스트리(resourceLoader)는 `agentDir/skills` 만
// 보므로, 루바토처럼 agentDir 밑에 skills/ 가 없는 배치에서는 그쪽이 0개가 된다.
// 그 레지스트리가 곧 TUI 자동완성 목록이라, 모델은 스킬을 아는데 화면에는
// 아무것도 안 뜨는 상태가 됐다.
//
// `--skill` 은 그 목록에 경로를 더해 주는 공식 통로다. 같은 SKILL_DIRS 를 넘겨
// 프롬프트와 UI 가 한 정본을 보게 한다. 중복은 senpi 가 realpath 로 걸러내므로
// 심링크로 같은 스킬이 두 번 들어와도 안전하다.
export function skillPathArgs(dirs = SKILL_DIRS) {
  return dirs.flatMap(({ dir }) => (existsSync(dir) ? ["--skill", dir] : []));
}

export function buildSenpiArgs(userArgs, { env = process.env } = {}) {
  const interactiveTuiArgs = userArgs.some((token) => token === "--mode" || token.startsWith("--mode=")) ||
    userArgs.some((token) => token === "--tui-mode" || token.startsWith("--tui-mode="))
    ? []
    : ["--tui-mode", "fullscreen"];
  return [
    senpiCliPath(),
    "--system-prompt",
    replaceSystemPrompt("", resolveRole({ env }), { env }),
    ...interactiveTuiArgs,
    ...skillPathArgs(),
    "-e",
    statuslinePath(),
    "-e",
    leadOverlayPath(),
    "-e",
    providerOverlayPath(),
    "-e",
    adapterPath(),
    ...userArgs,
  ];
}

export async function spawnRubatoPi({ args = process.argv.slice(2), env = process.env, agentDir = defaultAgentDir() } = {}) {
  assertExactPin();
  const node = resolveNode24();
  mkdirSync(agentDir, { recursive: true });
  // 우리가 소유한 전역 확장(현재 tps)을 senpi 가 자기 기본판으로 되돌리기 전에 깐다.
  ensureAgentExtensions(agentDir);
  // 지원 provider 는 정적이다. 예전에는 bridge 카탈로그를 매번 받아서 "새로 열린
  // 프로바이더가 disabled 에 영영 남는" 경우를 막았는데, 이제 등록하는 것이 pinned
  // native factory 뿐이라 런타임에 물을 대상이 없다.
  if (!sessionDefaultsLookCurrent(agentDir)) {
    ensureSessionDefaults(agentDir);
  }
  if (!existsSync(senpiCliPath())) {
    throw new Error("pinned senpi CLI is missing; run bun install at the repository root");
  }
  return spawn(node.bin, buildSenpiArgs(args), {
    env: withNoChangelog(launchEnv(env, agentDir)),
    stdio: "inherit",
  });
}
