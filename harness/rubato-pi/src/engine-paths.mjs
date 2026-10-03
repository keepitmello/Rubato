// 엔진 파일 경로를 한 군데로 모은다.
//
// 런처는 worktree 밖의 프로필 디렉터리에 만든 Rubato bundle을 읽는다.
// 생성물을 소스 트리에 두지 않아서 세션별 빌드가 git 상태를 더럽히지 않는다.
// 저장소 코드가 읽는 pi 패키지는 테스트 때 스테이징된 엔진, 그 밖엔 워크스페이스의 stock pi 다.
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

/**
 * Environment key naming a staged pi runtime root (stagePiRuntime output, the directory that holds
 * node_modules/@earendil-works/*). scripts/run-unit-tests.mjs stages the candidate features into a
 * temporary root and sets it, so tests read the same patched pi files the engine stages. Without it,
 * paths fall back to the workspace's pristine stock pi, which lacks the files Rubato stages.
 */
export const TEST_RUNTIME_ENV = "RUBATO_PI_TEST_RUNTIME";

function piModulesRoot(env = process.env) {
  const staged = env[TEST_RUNTIME_ENV];
  return typeof staged === "string" && staged.trim() !== "" ? join(staged, "node_modules") : join(repoRoot, "node_modules");
}

/** The node_modules that holds @earendil-works/* for repository code: staged when set, else the workspace. */
export const piModulesDir = piModulesRoot();

/** The coding-agent package Rubato runs on. */
export const codingAgentDir = join(piModulesDir, "@earendil-works", "pi-coding-agent");
/** @deprecated Use codingAgentDir. Kept for transforms and tests written against the senpi fork. */
export const legacySenpiDir = codingAgentDir;
/** @deprecated Use codingAgentDir. */
export const senpiDir = codingAgentDir;
export const senpiCli = join(codingAgentDir, "dist", "cli.js");
// Stock pi has no separate cli-main entry; cli.js is the whole CLI.
export const senpiCliMain = senpiCli;
export const senpiPackageJson = join(codingAgentDir, "package.json");
export const senpiExtensionRunner = join(codingAgentDir, "dist", "core", "extensions", "runner.js");
export const senpiSkillsModule = join(codingAgentDir, "dist", "core", "skills.js");
export const senpiSystemPromptModule = join(codingAgentDir, "dist", "core", "system-prompt.js");

/** A path inside the @earendil-works packages, e.g. workspaceNested("@earendil-works/pi-ai/dist/models.js"). */
export function workspaceNested(...segments) {
  return join(piModulesDir, ...segments);
}

/** @deprecated Use workspaceNested. */
export const senpiNested = workspaceNested;
