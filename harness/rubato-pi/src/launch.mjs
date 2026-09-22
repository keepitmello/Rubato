import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultAgentDir, launchEnv } from "./brand.mjs";
import { enableRubatoCompileCache } from "./compile-cache.mjs";
import { resolveRole } from "./role-contract.mjs";
import { listNodeCandidates, pickNode, runningNode } from "./select-node.mjs";
import { ensureSessionDefaults, sessionDefaultsLookCurrent } from "./session-defaults.mjs";
import { replaceSystemPrompt } from "./system-prompt.mjs";
import { SKILL_DIRS } from "./skills-section.mjs";
import { senpiCli, senpiCliMain } from "./engine-paths.mjs";
import { releaseBootChrome, setBootChromeStatus } from "./boot-chrome.mjs";
import { ENGINE_REPAIR_HINT, resolveExecutionEngine } from "./engine-selection.mjs";
import { removeRetiredAgentExtensions } from "./retired-agent-extensions.mjs";
export {
  isValidInstalledCandidateReceipt, readPiEngineReceipt, piEngineReceiptPresent,
  readEngineMarker, resolveLaunchEngine, ENGINE_REPAIR_HINT,
} from "./engine-selection.mjs";
export { nodeSatisfiesCandidate } from "./select-node.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export function packageRoot() {
  return root;
}

export function senpiCliPath() {
  return senpiCli;
}

export function senpiCliMainPath() {
  return senpiCliMain;
}

/** cli.js 는 --version 만 값싸다. 그 외는 cli-main 으로 가서 --import 이중 기동을 피한다. */
export function senpiEntryPath(userArgs = []) {
  if (userArgs.some((token) => token === "--version" || token === "-v")) return senpiCli;
  return senpiCliMain;
}

export function statuslinePath() {
  return join(root, "src/extensions/statusline.mjs");
}

export function providerOverlayPath() {
  return join(root, "src/extensions/provider-overlay.mjs");
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

const AGENT_DIR_ENV_NAMES = Object.freeze([
  "RUBATO_PI_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]);

export function resolveLaunchAgentDir(env = process.env, home = env.HOME || homedir()) {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value === "~") return home;
    if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
    return value;
  }
  return defaultAgentDir(home);
}

/**
 * pi argv. Candidate already supplies providers, prompt rules,
 * components, and the footer. Role system prompt is passed (--system-prompt)
 * and the candidate's rubato-role-prompt factory injects it on before_agent_start.
 * Keep fullscreen TUI and ~/.agents/skills, then pass user args through.
 */
export function buildPiArgs(userArgs, { env = process.env } = {}) {
  const interactiveTuiArgs = userArgs.some((token) => token === "--mode" || token.startsWith("--mode=")) ||
    userArgs.some((token) => token === "--tui-mode" || token.startsWith("--tui-mode="))
    ? []
    : ["--tui-mode", "fullscreen"];
  return [
    "--system-prompt",
    replaceSystemPrompt("", resolveRole({ env }), { env, argv: userArgs }),
    ...interactiveTuiArgs,
    ...skillPathArgs(),
    ...userArgs,
  ];
}

export function sameNodeBinary(nodeBin, execPath = process.execPath) {
  return nodeBin === execPath;
}

const STRIP_SENPI_KEYS = Object.freeze(["SENPI_BIN", "SENPI_BRAND", "SENPI_CODING_AGENT_DIR"]);

export function stripNoChangelogNodeOptions(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.includes("no-changelog-register")) continue;
    // Separate form "--import <loader>": drop the flag together with its value.
    if ((token === "--import" || token === "--require" || token === "-r") && tokens[i + 1]?.includes("no-changelog-register")) { i += 1; continue; }
    kept.push(token);
  }
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export function piSupportEnv() {
  return {
    RUBATO_BOOT_CHROME_HREF: pathToFileURL(join(here, "boot-chrome.mjs")).href,
    RUBATO_ROLE_PROMPT_MODULE: pathToFileURL(join(here, "system-prompt.mjs")).href,
    RUBATO_ROLE_CONTRACT_MODULE: pathToFileURL(join(here, "role-contract.mjs")).href,
  };
}

export function piLaunchEnv(baseEnv, agentDir) {
  const env = { ...launchEnv(baseEnv, agentDir), ...piSupportEnv(), RUBATO_CANDIDATE_AGENT_DIR: agentDir };
  for (const key of STRIP_SENPI_KEYS) delete env[key];
  const nodeOptions = stripNoChangelogNodeOptions(env.NODE_OPTIONS);
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  else delete env.NODE_OPTIONS;
  return env;
}

export function applyPiProcessEnv(nextEnv) {
  for (const key of STRIP_SENPI_KEYS) delete process.env[key];
  const stripped = stripNoChangelogNodeOptions(process.env.NODE_OPTIONS);
  if (stripped) process.env.NODE_OPTIONS = stripped;
  else delete process.env.NODE_OPTIONS;
  Object.assign(process.env, nextEnv);
  for (const key of STRIP_SENPI_KEYS) delete process.env[key];
}

function prepareAgentDir(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  removeRetiredAgentExtensions(agentDir);
  if (!sessionDefaultsLookCurrent(agentDir)) {
    ensureSessionDefaults(agentDir);
  }
}

async function runSameNode(entry, argv, nextEnv, { stockPi = false } = {}) {
  if (stockPi) applyPiProcessEnv(nextEnv);
  else Object.assign(process.env, nextEnv);
  process.argv = [process.execPath, ...argv];
  await import(pathToFileURL(entry).href);
  return undefined;
}

export async function spawnRubatoPi({ args = process.argv.slice(2), env = process.env, agentDir } = {}) {
  enableRubatoCompileCache(env);
  const profileDir = agentDir ?? resolveLaunchAgentDir(env);
  const selection = resolveExecutionEngine({ env });
  const node = selection.node;
  if (!node) throw new Error("rubato-pi needs Node.js ^24.15 || >=26 already installed. Default Node was not changed.");
  // Senpi launch is retired (user decree 2026-09-13): a broken pi install
  // fails loud here instead of silently falling back to senpi.
  if (selection.error) throw new Error(selection.error);
  const stockPiReady = selection.engine === "pi" || selection.engine === "stock-pi";
  if (selection.warning) console.error(selection.warning);
  setBootChromeStatus("엔진을 불러오는 중");

  if (stockPiReady) {
    const entry = selection.entry;
    if (!entry || !existsSync(entry)) {
      throw new Error(`rubato: pi entry is missing; ${ENGINE_REPAIR_HINT} to reinstall it`);
    } else {
      const argv = [entry, ...buildPiArgs(args, { env })];
      const nextEnv = piLaunchEnv(env, profileDir);
      if (sameNodeBinary(node.bin)) {
        const { installedSharedRuntime, isConversationLaunch, ensureProfileEngine } = await import('../../pi-server/src/discovery.mjs');
        const runtimeRoot = installedSharedRuntime(env);
        if (runtimeRoot && isConversationLaunch(args)) {
          const descriptor = await ensureProfileEngine({ descriptorPath: join(profileDir, 'server', 'connection.json'),
            nodeBin: node.bin, env: nextEnv, runtimeRoot, requireTerminal: true });
          releaseBootChrome();
          const { runTerminalClient } = await import('../../pi-server/src/terminal-client.mjs');
          process.exitCode = await runTerminalClient({ descriptor, args: argv.slice(1), env: nextEnv });
          return undefined;
        }
        prepareAgentDir(profileDir);
        return runSameNode(entry, argv, nextEnv, { stockPi: true });
      }
      releaseBootChrome();
      return spawn(node.bin, [join(root, "bin", "rubato-pi.mjs"), ...args], {
        env: { ...nextEnv, RUBATO_ENGINE: "pi" },
        stdio: "inherit",
      });
    }
  }
}

export const buildStockPiArgs = buildPiArgs;
export const stockPiSupportEnv = piSupportEnv;
export const stockPiLaunchEnv = piLaunchEnv;
export const applyStockPiProcessEnv = applyPiProcessEnv;
