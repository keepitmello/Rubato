#!/usr/bin/env node
// `rubato auth` — status, and `login` that runs the engine's OAuth.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveLaunchAgentDir } from "../rubato-pi/src/launch.mjs";
import { resolveLaunchEngine } from "../rubato-pi/src/engine-selection.mjs";
import {
  CLAUDE_SETUP_TOKEN_FILE_ENV,
  claudeAccount,
  claudeSetupTokenPath,
} from "../rubato-pi/src/anthropic-setup-token.mjs";

const LOGIN_ALIASES = Object.freeze({
  xai: "xai",
  grok: "xai",
  "openai-codex": "openai-codex",
  codex: "openai-codex",
  cursor: "cursor",
  "google-antigravity": "google-antigravity",
  antigravity: "google-antigravity",
});

const LOGIN_LABELS = Object.freeze({
  xai: "xAI",
  "openai-codex": "Codex",
  cursor: "Cursor",
  "google-antigravity": "Antigravity",
});

const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

export function authJsonPath(env = process.env, home = env.HOME || homedir()) {
  const explicit = env.RUBATO_AUTH_PATH || env.SENPI_AUTH_PATH;
  if (explicit) return explicit;
  const agent = resolveLaunchAgentDir(env, home);
  return join(agent, "auth.json");
}

export function resolveLoginProvider(name) {
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const key = name.trim().toLowerCase();
  if (key === "claude" || key === "anthropic") return { error: "claude" };
  return LOGIN_ALIASES[key] ? { id: LOGIN_ALIASES[key] } : { error: "unknown", name };
}

export function oauthPresence(entry) {
  if (!entry || typeof entry !== "object") return { ok: false };
  const token = typeof entry.access === "string" ? entry.access : typeof entry.key === "string" ? entry.key : "";
  if (!token) return { ok: false };
  const exp = entry.expires;
  if (typeof exp === "number") {
    const left = exp / 1000 - Date.now() / 1000;
    if (left < 0) return { ok: true, left: "expired" };
    return { ok: true, left: `${Math.floor(left / 3600)}h` };
  }
  return { ok: true, left: "" };
}

export function readAuthFile(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function ok(stdout, text) {
  stdout.write(`  ${GRN}✓${RST} ${text}\n`);
}
function miss(stdout, text) {
  stdout.write(`  ${YEL}✗${RST} ${text}\n`);
}
function hint(stdout, text) {
  stdout.write(`      ${DIM}${text}${RST}\n`);
}

export function printStatus({ stdout = process.stdout, env = process.env, home = env.HOME || homedir() } = {}) {
  const authPath = authJsonPath(env, home);
  const auth = existsSync(authPath) ? readAuthFile(authPath) : {};
  stdout.write(`\n${BOLD}== rubato auth ==${RST}\n`);
  for (const [id, label] of Object.entries(LOGIN_LABELS)) {
    const presence = oauthPresence(auth[id]);
    if (!presence.ok) {
      miss(stdout, `${label} — 없다`);
      hint(stdout, `rubato auth login ${id}`);
      continue;
    }
    if (presence.left === "expired") {
      miss(stdout, `${label} — 토큰이 만료됐다`);
      hint(stdout, `rubato auth login ${id}`);
    } else if (presence.left) ok(stdout, `${label}  (남은 시간 ~${presence.left})`);
    else ok(stdout, label);
  }

  const tokenFile = claudeSetupTokenPath(env, home);
  const account = claudeAccount(env);
  try {
    const head = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").slice(0, 12) : "";
    if (head.startsWith("sk-ant-oat")) ok(stdout, `Claude 장기 setup-token  (${tokenFile})`);
    else {
      miss(stdout, `Claude — 없다 (계정: ${account})`);
      hint(stdout, "claude setup-token 을 돌려 sk-ant-oat... 를 받는다");
      hint(stdout, `${CLAUDE_SETUP_TOKEN_FILE_ENV} 또는 파일 ${tokenFile}`);
    }
  } catch {
    miss(stdout, `Claude — 없다 (계정: ${account})`);
  }
  stdout.write("\n");
}

export function printLoginUsage(stdout = process.stdout) {
  stdout.write("usage: rubato auth login <provider>\n");
  stdout.write(`providers: ${Object.keys(LOGIN_LABELS).join(", ")}\n`);
  stdout.write("Claude is a setup-token, not OAuth: claude setup-token\n");
}

export async function createCliInteraction({
  stdin = process.stdin,
  stdout = process.stdout,
  openUrl,
} = {}) {
  const open = openUrl ?? ((url) => {
    stdout.write(`${url}\n`);
  });
  return {
    async prompt(prompt) {
      if (prompt.type === "select") {
        const browser = prompt.options.find((option) => /browser/i.test(`${option.id} ${option.label}`));
        if (browser && stdin.isTTY) return browser.id;
        stdout.write(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          stdout.write(`  ${index + 1}) ${option.label}\n`);
        });
        const line = await readPromptLine(stdin, stdout, prompt.signal);
        const asNumber = Number.parseInt(line, 10);
        if (Number.isInteger(asNumber) && prompt.options[asNumber - 1]) return prompt.options[asNumber - 1].id;
        const match = prompt.options.find((option) => option.id === line || option.label === line);
        if (match) return match.id;
        throw new Error(`Unknown login option: ${line}`);
      }
      stdout.write(`${prompt.message}\n`);
      return readPromptLine(stdin, stdout, prompt.signal);
    },
    notify(event) {
      if (event.type === "auth_url") {
        if (event.instructions) stdout.write(`${event.instructions}\n`);
        stdout.write(`${event.url}\n`);
        open(event.url);
        return;
      }
      if (event.type === "device_code") {
        stdout.write(`Open ${event.verificationUri}\nEnter code: ${event.userCode}\n`);
        open(event.verificationUri);
        return;
      }
      if (event.type === "info" || event.type === "progress") stdout.write(`${event.message}\n`);
    },
  };
}

async function readPromptLine(stdin, stdout, signal) {
  const rl = createInterface({ input: stdin, output: stdout });
  const onAbort = () => rl.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Login cancelled");
    return await rl.question("> ");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
  }
}

async function loadOpenBrowser(root) {
  const file = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/utils/open-browser.js");
  const { openBrowser } = await import(pathToFileURL(file).href);
  return openBrowser;
}

async function loadModelRuntime(root) {
  const file = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js");
  const { ModelRuntime } = await import(pathToFileURL(file).href);
  return ModelRuntime;
}

export async function loginWithRuntime(runtime, providerId, interaction) {
  await runtime.login(providerId, "oauth", interaction);
}

async function runLogin(providerId, { env = process.env, stdout = process.stdout, stdin = process.stdin } = {}) {
  const selection = resolveLaunchEngine({ env });
  if (selection.warning) stdout.write(`${selection.warning}\n`);
  if (selection.error) throw new Error(selection.error);
  const agentDir = resolveLaunchAgentDir(env);
  env.PI_CODING_AGENT_DIR ??= agentDir;
  env.RUBATO_PI_CODING_AGENT_DIR ??= agentDir;
  const ModelRuntime = await loadModelRuntime(selection.root);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const openBrowser = await loadOpenBrowser(selection.root);
  const interaction = await createCliInteraction({
    stdin,
    stdout,
    openUrl: (url) => openBrowser(url),
  });
  stdout.write(`Logging in to ${LOGIN_LABELS[providerId] ?? providerId}…\n`);
  await loginWithRuntime(runtime, providerId, interaction);
  stdout.write(`Logged in. Credentials: ${join(agentDir, "auth.json")}\n`);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stdin = io.stdin ?? process.stdin;
  const env = io.env ?? process.env;
  if (argv[0] === "login") {
    const resolved = resolveLoginProvider(argv[1]);
    if (!resolved || resolved.error === "unknown") {
      printLoginUsage(stdout);
      if (resolved?.name) stdout.write(`Unknown provider: ${resolved.name}\n`);
      process.exitCode = 2;
      return;
    }
    if (resolved.error === "claude") {
      stdout.write("Claude uses a long-lived setup-token, not OAuth.\n");
      stdout.write(`Run: claude setup-token\nWrite it to the path in ${CLAUDE_SETUP_TOKEN_FILE_ENV}\n`);
      process.exitCode = 2;
      return;
    }
    await runLogin(resolved.id, { env, stdout, stdin });
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    stdout.write("usage: rubato auth\n       rubato auth login <provider>\n");
    return;
  }
  if (argv.length > 0) {
    stdout.write("usage: rubato auth\n       rubato auth login <provider>\n");
    process.exitCode = 2;
    return;
  }
  printStatus({ stdout, env });
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
