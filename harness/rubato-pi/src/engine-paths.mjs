// 엔진 파일 경로를 한 군데로 모은다.
//
// 런처는 worktree 밖의 프로필 디렉터리에 만든 Rubato bundle을 읽는다.
// 생성물을 소스 트리에 두지 않아서 세션별 빌드가 git 상태를 더럽히지 않는다.
// 워크스페이스에 남은 @code-yeongyu/senpi 는 레거시 테스트·트랜스폼 픽스처다.
import { existsSync } from "node:fs";
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
 * Product state dir (~/.rubato-pi). When HOME is set it wins, so a temp HOME
 * cannot leak writes to the live profile via userInfo().homedir.
 */
export function rubatoStateDir(env = process.env) {
  if (typeof env.HOME === "string" && env.HOME.trim() !== "") return join(env.HOME, ".rubato-pi");
  const real = realUserHome();
  return real ? join(real, ".rubato-pi") : "";
}

export function defaultPiEngineDir(home) {
  return join(home, ".rubato-pi", "pi");
}

/** Legacy cutover path. Existing installs and tests still plant receipts here. */
export function defaultStockEngineDir(home) {
  return join(home, ".rubato-pi", "stock-engine");
}

export function resolvePiEngineDir(env = process.env) {
  const pinned = env.RUBATO_PI_ENGINE_DIR || env.RUBATO_STOCK_ENGINE_DIR;
  if (typeof pinned === "string" && pinned.trim() !== "") return pinned;
  const state = rubatoStateDir(env);
  if (!state) return "";
  const next = join(state, "pi");
  const legacy = join(state, "stock-engine");
  if (existsSync(join(legacy, "rubato-install.json")) && !existsSync(join(next, "rubato-install.json"))) return legacy;
  return next;
}

/** @deprecated Use resolvePiEngineDir. */
export const resolveStockEngineDir = resolvePiEngineDir;

export function engineMarkerPath(env = process.env) {
  const state = rubatoStateDir(env);
  return state ? join(state, "engine.json") : "";
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

/** Workspace leftover of the retired fork; tests/transforms that still import its dist. */
export const legacySenpiDir = join(repoRoot, "node_modules", "@code-yeongyu", "senpi");
/** @deprecated Use legacySenpiDir. */
export const senpiDir = legacySenpiDir;
export const senpiCli = join(legacySenpiDir, "dist", "cli.js");
export const senpiCliMain = join(legacySenpiDir, "dist", "cli-main.js");
export const senpiPackageJson = join(legacySenpiDir, "package.json");
export const senpiExtensionRunner = join(legacySenpiDir, "dist", "core", "extensions", "runner.js");
export const senpiSkillsModule = join(legacySenpiDir, "dist", "core", "skills.js");
export const senpiSystemPromptModule = join(legacySenpiDir, "dist", "core", "system-prompt.js");

/**
 * Packages nested under the leftover senpi install, or hoisted into the workspace.
 */
export function workspaceNested(...segments) {
  const nested = join(legacySenpiDir, "node_modules", ...segments);
  if (existsSync(nested)) return nested;
  return join(repoRoot, "node_modules", ...segments);
}

/** @deprecated Use workspaceNested. */
export const senpiNested = workspaceNested;
