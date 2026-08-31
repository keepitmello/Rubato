// 엔진 파일 경로를 한 군데로 모은다.
//
// 런처는 worktree 밖의 프로필 디렉터리에 만든 Rubato bundle을 읽는다.
// 생성물을 소스 트리에 두지 않아서 세션별 빌드가 git 상태를 더럽히지 않는다.
// senpi 본체는 workspace에 설치된 고정 버전을 쓴다.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** harness/rubato-pi */
export const rubatoPiRoot = join(here, "..");

/** repository root (harness/rubato-pi -> harness -> repo) */
export const repoRoot = join(rubatoPiRoot, "..", "..");

function realUserHome() {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

function pluginDirUnder(home) {
  return home ? join(home, ".rubato-pi", "engine", "plugin") : "";
}

function looksLikeEnginePluginDir(dir) {
  return Boolean(dir) && existsSync(join(dir, "package.json")) && existsSync(join(dir, "extensions", "rubato.js"));
}

/**
 * HOME 이 테스트용 빈 디렉터리여도 실제 산출물을 찾는다.
 * `userInfo().homedir` 는 process.env.HOME 을 무시한다.
 */
function pinnedEngineDir(env) {
  const raw = env.RUBATO_ENGINE_DIR;
  return typeof raw === "string" && raw.trim() !== "" ? raw : "";
}

/**
 * 비어 있지 않은 RUBATO_ENGINE_DIR 은 권위다. 그 자리가 없거나 불완전해도
 * ~/.rubato-pi 로 내려가지 않는다. 없으면 그 경로에서 실패해야 한다.
 */
export function resolveEnginePluginDir(env = process.env) {
  const pinned = pinnedEngineDir(env);
  if (pinned) return pinned;
  const fromHome = pluginDirUnder(env.HOME ?? "");
  if (looksLikeEnginePluginDir(fromHome)) return fromHome;
  const fromReal = pluginDirUnder(realUserHome());
  if (looksLikeEnginePluginDir(fromReal)) return fromReal;
  return fromHome || fromReal;
}

/**
 * 우리가 빌드한 Rubato 확장. component 선택이 반영된 판이다.
 * 레포 밖에 둔다 — 이유는 파일 첫머리 주석에 있다.
 */
export const enginePluginDir = resolveEnginePluginDir();

export const rubatoExtension = join(enginePluginDir, "extensions", "rubato.js");
export const rubatoTaskExtension = join(enginePluginDir, "extensions", "rubato-task.js");
export const rubatoMemberExtension = join(enginePluginDir, "extensions", "rubato-member.js");
export const enginePackageJson = join(enginePluginDir, "package.json");

/** senpi 본체는 repository workspace에 설치한 것을 쓴다. */
export const senpiDir = join(repoRoot, "node_modules", "@code-yeongyu", "senpi");
export const senpiCli = join(senpiDir, "dist", "cli.js");
export const senpiPackageJson = join(senpiDir, "package.json");
export const senpiSkillsModule = join(senpiDir, "dist", "core", "skills.js");
export const senpiSystemPromptModule = join(senpiDir, "dist", "core", "system-prompt.js");

/**
 * senpi 가 자기 node_modules 에 품고 있는 패키지. 워크스페이스 호이스팅 탓에
 * 로컬에 올라오기도 하므로 둘 다 본다 — 먼저 발견되는 쪽을 돌려준다.
 */
export function senpiNested(...segments) {
  const nested = join(senpiDir, "node_modules", ...segments);
  if (existsSync(nested)) return nested;
  return join(repoRoot, "node_modules", ...segments);
}

/**
 * 번들은 `@earendil-works/pi-tui` 를 external 로 남긴다. senpi 로더를 안 거치는
 * `await import(rubatoExtension)` 경로(lead-overlay / adapter)는 node 가
 * 산출물 옆 node_modules 부터 찾는다. 릴리스가 /tmp 에 빌드되면 그 심링크가
 * 끊겨 "Cannot find package '@earendil-works/pi-tui'" 로 확장이 통째로 죽는다.
 */
export function engineNodeModuleLinkPairs(pluginDir, repo = repoRoot) {
  const nested = join(repo, "node_modules", "@code-yeongyu", "senpi", "node_modules");
  const rootModules = join(repo, "node_modules");
  return [
    [join(pluginDir, "node_modules"), rootModules],
    [join(pluginDir, "extensions", "node_modules"), existsSync(nested) ? nested : rootModules],
  ];
}

function sameSymlink(linkPath, target) {
  try {
    return lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === target;
  } catch {
    return false;
  }
}

export function ensureEngineNodeModules(pluginDir = enginePluginDir, repo = repoRoot) {
  if (!pluginDir || !existsSync(pluginDir)) return [];
  const linked = [];
  for (const [linkPath, target] of engineNodeModuleLinkPairs(pluginDir, repo)) {
    if (!existsSync(target)) continue;
    if (sameSymlink(linkPath, target)) continue;
    try {
      if (existsSync(linkPath) && !lstatSync(linkPath).isSymbolicLink()) continue;
    } catch {
      // Missing or dangling link — replace below.
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(target, linkPath, "dir");
    linked.push(linkPath);
  }
  return linked;
}

/** 없으면 세션이 못 뜨므로, 부팅 실패를 사유와 함께 세운다. */
export function assertEngineBuilt(env = process.env) {
  const pluginDir = resolveEnginePluginDir(env);
  const extension = join(pluginDir, "extensions", "rubato.js");
  if (!existsSync(extension)) {
    throw new Error(
      `rubato-pi: 엔진 산출물이 없다 - ${extension}\n` +
        `repository root에서 빌드해라: node harness/scripts/build-engine.mjs (bun 1.4+)`,
    );
  }
  ensureEngineNodeModules(pluginDir);
}

if (looksLikeEnginePluginDir(enginePluginDir)) {
  ensureEngineNodeModules(enginePluginDir);
}
