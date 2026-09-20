#!/usr/bin/env node
// `rubato auth` — 상태, 방향키 로그인, 여러 계정 등록.
//
// TTY 에서는 명령어를 치지 않는다. 화살표로 고르고 Enter 로 들어가고 Esc 로 나온다.
// 붙여넣기가 본질인 자리(API 키, setup-token)만 줄 입력을 쓴다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolveLaunchAgentDir } from "../rubato-pi/src/launch.mjs";
import { resolveLaunchEngine } from "../rubato-pi/src/engine-selection.mjs";
import {
  CLAUDE_SETUP_TOKEN_PREFIX,
  claudeAccount,
  claudeSetupTokenPath,
} from "../rubato-pi/src/anthropic-setup-token.mjs";
import {
  getCredentialAccounts,
  pinCredentialAccount,
  removeCredentialAccount,
} from "../pi-runtime/features/providers/auth-pool/accounts.mjs";
import {
  appendLoginSlot,
  findSlot,
  listSlots,
  mergeRefreshedSlot,
  projectSlot,
} from "../pi-runtime/features/providers/auth-pool/slots.mjs";
import { CredentialSlotRepository } from "../pi-runtime/features/providers/auth-pool/state-store.mjs";
import { BACK, QUIT, SHOW_CURSOR, createKeyReader, runMenu } from "./auth-menu.mjs";

export const PROVIDERS = Object.freeze([
  { id: "openai-codex", label: "Codex", aliases: ["openai-codex", "codex"], methods: ["oauth"] },
  { id: "xai", label: "xAI", aliases: ["xai", "grok"], methods: ["oauth", "api_key"] },
  { id: "cursor", label: "Cursor", aliases: ["cursor"], methods: ["oauth"] },
  { id: "anthropic", label: "Anthropic", aliases: ["anthropic", "claude"], methods: ["oauth", "setup-token"] },
  { id: "kiro", label: "Kiro", aliases: ["kiro"], methods: ["api_key"] },
  { id: "google-antigravity", label: "Antigravity", aliases: ["google-antigravity", "antigravity"], methods: ["oauth"] },
  { id: "opencode", label: "OpenCode", aliases: ["opencode"], methods: ["api_key"] },
  { id: "b-ai", label: "DeepSeek", aliases: ["b-ai", "deepseek"], methods: ["api_key"] },
]);

const METHOD_ALIASES = Object.freeze({
  oauth: "oauth",
  key: "api_key",
  api_key: "api_key",
  "api-key": "api_key",
  token: "setup-token",
  "setup-token": "setup-token",
  "setup_token": "setup-token",
});

const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

const LOGIN_ALIASES = Object.freeze(
  Object.fromEntries(PROVIDERS.flatMap((provider) => provider.aliases.map((alias) => [alias, provider.id]))),
);

const LOGIN_LABELS = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.label])));

export function providerSpec(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function authJsonPath(env = process.env, home = env.HOME || homedir()) {
  const explicit = env.RUBATO_AUTH_PATH || env.SENPI_AUTH_PATH;
  if (explicit) return explicit;
  const agent = resolveLaunchAgentDir(env, home);
  return join(agent, "auth.json");
}

export function poolStatePath(env = process.env, home = env.HOME || homedir()) {
  const explicit = env.RUBATO_AUTH_POOL_STATE;
  if (explicit) return explicit;
  return join(dirname(authJsonPath(env, home)), "credential-pool-state.json");
}

export function resolveLoginProvider(name) {
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const key = name.trim().toLowerCase();
  return LOGIN_ALIASES[key] ? { id: LOGIN_ALIASES[key] } : { error: "unknown", name };
}

export function resolveLoginMethod(providerId, name) {
  const spec = providerSpec(providerId);
  if (!spec) return { error: "unknown", name };
  if (name === undefined || name === "") return { id: spec.methods[0] };
  const method = METHOD_ALIASES[String(name).trim().toLowerCase()];
  if (!method || !spec.methods.includes(method)) {
    return { error: "method", name, methods: spec.methods };
  }
  return { id: method };
}

/**
 * 계정 하나의 상태. **남은 시간은 답이 아니다.**
 *
 * `auth.json` 의 `expires` 는 액세스 토큰 수명이고, 런타임(`auth/resolve.js`)이 쓰기
 * 직전에 5분 미만이면 스스로 갱신해 다시 저장한다. 그러니 "만료"는 고장이 아니라
 * 그 계정으로 최근에 호출하지 않았다는 뜻일 뿐이고, 카운트다운은 사용자가 어떤
 * 판단에도 쓸 수 없는 숫자다. 화면에서 뺀다.
 *
 * 진짜 신호는 두 개다. refresh 토큰조차 없는데 만료됐으면(`stale`) 갱신할 길이
 * 없고, 실제 호출에서 인증을 거부당해 pool 이 차단한 계정(`blocked`)은 쓰이지
 * 않는다. 나머지는 "연결됨"이고, 정말 살아 있는지는 `연결 확인`이 답한다.
 */
export function slotPresence(slot) {
  if (!slot || typeof slot !== "object") return { ok: false, state: "absent" };
  const access = typeof slot.access === "string" ? slot.access : "";
  const key = typeof slot.key === "string" ? slot.key : "";
  if (!access && !key) return { ok: false, state: "absent" };
  if (!access) return { ok: true, state: "connected" };
  const expires = typeof slot.expires === "number" && slot.expires > 0 ? slot.expires : undefined;
  if (expires === undefined || expires > Date.now()) return { ok: true, state: "connected" };
  return typeof slot.refresh === "string" && slot.refresh
    ? { ok: true, state: "connected" }
    : { ok: true, state: "stale" };
}

/** 화면에 쓸 계정 상태. pool 의 차단 기록이 파일의 내용보다 세다. */
export function accountState(slot, account) {
  if (account?.blocked) return "blocked";
  if (account && account.source !== "login") return "connected";
  return slotPresence(slot).state;
}

const STATE_RANK = Object.freeze({ connected: 0, stale: 1, blocked: 2, absent: 3 });

export function bestState(states) {
  return states.reduce((best, state) => (STATE_RANK[state] < STATE_RANK[best] ? state : best), "absent");
}

export function describeState(state) {
  if (state === "connected") return "연결됨";
  if (state === "blocked") return "차단됨 · 재로그인 필요";
  if (state === "stale") return "재로그인 필요";
  return "로그인 필요";
}

export function readAuthFile(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function createFileCredentials(authPath) {
  const load = () => (existsSync(authPath) ? readAuthFile(authPath) : {});
  const save = (all) => {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  return {
    async read(provider) {
      return load()[provider];
    },
    async modify(provider, fn) {
      const all = load();
      const next = await fn(all[provider]);
      if (next === undefined) delete all[provider];
      else all[provider] = next;
      save(all);
      return next;
    },
    async delete(provider) {
      const all = load();
      delete all[provider];
      save(all);
    },
  };
}

export function setupTokenPresent({ env = process.env, home = env.HOME || homedir() } = {}) {
  const path = claudeSetupTokenPath(env, home);
  try {
    const head = existsSync(path) ? readFileSync(path, "utf8").slice(0, CLAUDE_SETUP_TOKEN_PREFIX.length) : "";
    return head.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function writeSetupToken(token, { env = process.env, home = env.HOME || homedir() } = {}) {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) || trimmed.length <= CLAUDE_SETUP_TOKEN_PREFIX.length) {
    throw new Error(`setup-token must start with ${CLAUDE_SETUP_TOKEN_PREFIX}`);
  }
  const path = claudeSetupTokenPath(env, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${trimmed}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function storeApiKey(credentials, providerId, key) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) throw new Error("API key is empty");
  const current = await credentials.read(providerId);
  const next = appendLoginSlot(current, { type: "api_key", key: trimmed });
  await credentials.modify(providerId, async () => next);
  return next;
}

function credentialsOf(ctx) {
  return ctx.credentials ?? createFileCredentials(authJsonPath(ctx.env, ctx.home));
}

function repositoryOf(ctx) {
  return ctx.repository ?? new CredentialSlotRepository(poolStatePath(ctx.env, ctx.home));
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

function methodHint(id) {
  const spec = providerSpec(id);
  if (!spec) return `rubato auth login ${id}`;
  if (spec.methods.length === 1 && spec.methods[0] === "setup-token") return `rubato auth login ${id} token`;
  if (spec.methods.includes("oauth") && spec.methods.includes("setup-token")) {
    return `rubato auth login ${id} oauth  |  rubato auth login ${id} token`;
  }
  if (spec.methods[0] === "api_key") return `rubato auth login ${id} key`;
  return `rubato auth login ${id}`;
}

/**
 * provider 별 상태. TUI 목록과 `rubato auth status` 가 같은 계산을 쓴다.
 *
 * `auth.json` 만 보지 않는다. 실제 호출에서 거부당한 기록은 `credential-pool-state.json`
 * 에 있고 그쪽이 더 센 증거다 — 파일에 멀쩡한 토큰이 있어도 pool 이 차단한 계정은
 * 아무 요청에도 쓰이지 않는다.
 */
export async function collectStatus(ctx) {
  const rows = [];
  for (const provider of PROVIDERS) {
    const entry = await credentialsOf(ctx).read(provider.id);
    const slotByName = new Map(listSlots(entry).map((slot) => [slot.name, slot]));
    const accounts = (await listProviderAccounts(provider.id, ctx)).map((account) => ({
      ...account,
      state: accountState(slotByName.get(account.name), account),
    }));
    rows.push({
      provider,
      accounts,
      state: bestState(accounts.map((account) => account.state)),
      blockedCount: accounts.filter((account) => account.state === "blocked").length,
    });
  }
  return rows;
}

function summaryOf(row) {
  const parts = [describeState(row.state)];
  if (row.state === "connected" && row.blockedCount > 0) parts.push(`${row.blockedCount}개 차단됨`);
  if (row.accounts.length > 1) parts.push(`계정 ${row.accounts.length}`);
  return parts.join(" · ");
}

export async function printStatus(ctx = {}) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write(`\n${BOLD}== rubato auth ==${RST}\n`);
  const rows = await collectStatus(ctx);
  rows.forEach((row, index) => {
    const write = row.state === "connected" ? ok : miss;
    write(stdout, `${index + 1}) ${row.provider.label} — ${summaryOf(row)}`);
    if (row.state !== "connected") hint(stdout, methodHint(row.provider.id));
    for (const account of row.accounts) {
      hint(stdout, `${account.name} | ${account.source} | ${describeState(account.state)}${account.pinned ? " | 고정됨" : ""}`);
    }
  });
  stdout.write("\n");
}

export function printUsage(stdout = process.stdout) {
  stdout.write("usage: rubato auth\n");
  stdout.write("       rubato auth login <provider> [oauth|token|key]\n");
  stdout.write("       rubato auth list [provider]\n");
  stdout.write("       rubato auth pin <provider> <name>\n");
  stdout.write("       rubato auth unpin <provider>\n");
  stdout.write("       rubato auth remove <provider> <name>\n");
  stdout.write(`providers: ${PROVIDERS.map((provider) => provider.id).join(", ")}\n`);
  stdout.write("Anthropic: oauth or token (sk-ant-oat setup-token). Token stays in ~/.claude, not auth.json.\n");
}

export function printLoginUsage(stdout = process.stdout) {
  printUsage(stdout);
}

function formatAccount(account) {
  const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
  if (account.pinned) states.push("pinned");
  return states.join(" | ");
}

export async function listProviderAccounts(providerId, ctx) {
  return getCredentialAccounts(credentialsOf(ctx), providerId, ctx.env ?? {}, repositoryOf(ctx));
}

export async function printProviderAccounts(providerId, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  const spec = providerSpec(providerId);
  const accounts = await listProviderAccounts(providerId, ctx);
  stdout.write(`${BOLD}${spec?.label ?? providerId}${RST}\n`);
  if (accounts.length === 0) hint(stdout, "(none)");
  else for (const account of accounts) hint(stdout, formatAccount(account));
  if (providerId === "anthropic" && !accounts.some((account) => account.source === "setup-token")) {
    hint(stdout, `setup-token 파일: ${claudeSetupTokenPath(ctx.env, ctx.home)}  (계정 ${claudeAccount(ctx.env)})`);
  }
  stdout.write("\n");
  return accounts;
}

export async function createCliInteraction({
  stdin = process.stdin,
  stdout = process.stdout,
  openUrl,
} = {}) {
  const open = openUrl ?? ((url) => {
    stdout.write(`${url}\n`);
  });
  // 열린 줄 입력을 붙잡아 둔다. Antigravity 는 브라우저 콜백과 수동 붙여넣기를
  // 경주시키는데, 콜백이 이기면 붙여넣기 프롬프트는 영영 답을 받지 못한다. 닫지
  // 않으면 그 readline 이 stdin 을 계속 쥐고 있어 로그인 후 메뉴가 키를 못 받는다.
  const open_prompts = new Set();
  const readLineHere = (signal) => readPromptLine(stdin, stdout, signal, open_prompts);
  // 빈 입력은 취소다. 방향키만으로 도는 화면에서 프롬프트를 빠져나갈 길은 Enter
  // 뿐인데, 그 빈 문자열을 그대로 흘려보내면 엔진이 키 없는 계정을 하나 만든다
  // (실측: xAI API 키 자리에서 Enter → `login-3 | 로그인 필요`).
  //
  // `manual_code` 만 예외다. Antigravity 는 브라우저 콜백과 이 프롬프트를 경주시켜서,
  // 여기서 던지면 콜백이 이길 수 있는 로그인까지 같이 무너진다.
  const answerOrCancel = async (prompt) => {
    const line = await readLineHere(prompt.signal);
    if (prompt.type !== "manual_code" && String(line).trim() === "") {
      throw new Error("취소했습니다.");
    }
    return line;
  };
  return {
    close() {
      for (const rl of open_prompts) rl.close();
      open_prompts.clear();
    },
    async prompt(prompt) {
      if (prompt.type === "select") {
        const browser = prompt.options.find((option) => /browser/i.test(`${option.id} ${option.label}`));
        if (browser && stdin.isTTY) return browser.id;
        stdout.write(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          stdout.write(`  ${index + 1}) ${option.label}\n`);
        });
        const line = await answerOrCancel(prompt);
        const asNumber = Number.parseInt(line, 10);
        if (Number.isInteger(asNumber) && prompt.options[asNumber - 1]) return prompt.options[asNumber - 1].id;
        const match = prompt.options.find((option) => option.id === line || option.label === line);
        if (match) return match.id;
        throw new Error(`고를 수 없는 항목입니다: ${line}`);
      }
      stdout.write(`${prompt.message}\n`);
      if (prompt.type !== "manual_code") stdout.write(`${DIM}그냥 Enter 를 누르면 취소됩니다.${RST}\n`);
      return answerOrCancel(prompt);
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

async function readPromptLine(stdin, stdout, signal, registry) {
  const rl = createInterface({ input: stdin, output: stdout });
  registry?.add(rl);
  const onAbort = () => rl.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Login cancelled");
    return await rl.question("> ");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    registry?.delete(rl);
    rl.close();
  }
}

async function readLine(ctx, prompt = "> ") {
  if (typeof ctx.readLine === "function") return String(await ctx.readLine(prompt) ?? "").trim();
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return String(await rl.question(prompt)).trim();
  } finally {
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

/**
 * 스톡 엔진이 모르는 provider. 세션에서는 Rubato providers 확장이 붙여 주지만
 * `rubato auth` 는 맨 런타임을 만들므로 여기서 직접 등록해야 한다. 등록하지 않으면
 * `Unknown provider: google-antigravity` 로 로그인이 통째로 막힌다 (cursor 도 같다).
 */
const RUBATO_OWNED_PROVIDERS = Object.freeze({
  "google-antigravity": async (env) => {
    const { antigravityDirectProvider } = await import("../rubato-pi/src/antigravity-route.mjs");
    const built = await antigravityDirectProvider({ env });
    return built.provider;
  },
  cursor: async (env) => {
    const { cursorDirectProvider } = await import("../rubato-pi/src/cursor-route.mjs");
    return cursorDirectProvider({ env });
  },
  kiro: async (env) => {
    const { kiroDirectProvider } = await import("../rubato-pi/src/kiro-route.mjs");
    return kiroDirectProvider({ env });
  },
});

export async function ensureProviderRegistered(runtime, providerId, env) {
  if (runtime.models?.providers?.has?.(providerId)) return;
  const build = RUBATO_OWNED_PROVIDERS[providerId];
  if (!build) return;
  runtime.registerNativeProvider(await build(env));
}

export async function loginWithRuntime(runtime, providerId, type, interaction) {
  if (typeof type === "object" && type !== null) {
    interaction = type;
    type = "oauth";
  }
  await runtime.login(providerId, type ?? "oauth", interaction);
}

async function engineRuntime(providerId, ctx) {
  const env = ctx.env ?? process.env;
  const stdout = ctx.stdout ?? process.stdout;
  const selection = resolveLaunchEngine({ env });
  if (selection.warning) stdout.write(`${selection.warning}\n`);
  if (selection.error) throw new Error(selection.error);
  const agentDir = resolveLaunchAgentDir(env);
  env.PI_CODING_AGENT_DIR ??= agentDir;
  env.RUBATO_PI_CODING_AGENT_DIR ??= agentDir;
  const ModelRuntime = await loadModelRuntime(selection.root);
  const runtime = await ModelRuntime.create({
    authPath: authJsonPath(env, ctx.home),
    refreshOnCreate: false,
  });
  await ensureProviderRegistered(runtime, providerId, env);
  return { runtime, root: selection.root, env };
}

async function runEngineLogin(providerId, type, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  const stdin = ctx.stdin ?? process.stdin;
  const { runtime, root, env } = await engineRuntime(providerId, ctx);
  const openBrowser = ctx.openUrl ? undefined : await loadOpenBrowser(root);
  const interaction = await createCliInteraction({
    stdin,
    stdout,
    openUrl: ctx.openUrl ?? ((url) => openBrowser(url)),
  });
  stdout.write(`${LOGIN_LABELS[providerId] ?? providerId} 에 로그인합니다 (${type})…\n`);
  try {
    await loginWithRuntime(runtime, providerId, type, interaction);
  } finally {
    interaction.close?.();
  }
  stdout.write(`로그인했습니다. 자격증명 위치: ${authJsonPath(env, ctx.home)}\n`);
}

/**
 * 계정 하나로 실제 갱신을 한 번 돌려 본다. 파일만 보고 추측하지 않고, 호출이
 * 되는지를 직접 묻는 유일한 자리다.
 *
 * 성공하면 회전된 자격증명을 저장하고 pool 의 차단 기록을 지운다. `auth_error` 는
 * pool 안에서 영구 차단이라 그 계정은 다시 선택되지 않고, 따라서 정상 경로의
 * `onSuccess` 가 영영 실행되지 않는다 — 사람이 확인해 주는 이 자리가 유일한 해제다.
 */
export async function verifyAccount(providerId, accountName, ctx) {
  const credentials = credentialsOf(ctx);
  const current = await credentials.read(providerId);
  const slot = findSlot(current, accountName);
  if (!slot || typeof slot.refresh !== "string" || slot.refresh === "") {
    return { kind: "unsupported" };
  }
  const { runtime } = await engineRuntime(providerId, ctx);
  const refresh = runtime.models?.providers?.get(providerId)?.auth?.oauth?.refresh;
  if (typeof refresh !== "function") return { kind: "unsupported" };
  const view = projectSlot(current, accountName) ?? current;
  let refreshed;
  try {
    refreshed = await refresh(view, undefined);
  } catch (error) {
    // 갱신 실패가 곧 사용 불가는 아니다. Cursor 의 액세스 토큰은 한 달 넘게 살아
    // 있는데 갱신 엔드포인트는 따로 죽을 수 있다 — 지금은 되고 만료되면 끝나는
    // 상태다. 그 둘을 한 낱말로 뭉뚱그리면 화면이 거짓말을 하게 된다.
    const usable = slotPresence(slot).state === "connected"
      && typeof slot.expires === "number" && slot.expires > Date.now();
    return { kind: usable ? "renew_failed" : "stale", reason: error instanceof Error ? error.message : String(error), expires: slot.expires };
  }
  await credentials.modify(providerId, async (now) => mergeRefreshedSlot(now, accountName, refreshed));
  await repositoryOf(ctx).mutateSlotState(providerId, "stored", accountName, (state) => (state
    ? { ...state, failureCount: 0, lease: undefined, blockedUntil: undefined, blockReason: undefined, lastSuccessAt: Date.now() }
    : state));
  return { kind: "ok" };
}

async function addSetupToken(ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write("sk-ant-oat… 로 시작하는 토큰을 붙여넣어 주세요. 그냥 Enter 를 누르면 취소됩니다.\n");
  stdout.write(`토큰이 없으면 먼저 실행해 주세요: claude setup-token\n`);
  const existing = setupTokenPresent(ctx);
  if (existing) stdout.write(`기존 파일을 덮어씁니다: ${existing}\n`);
  const token = await readLine(ctx);
  if (!token) {
    stdout.write("취소했습니다.\n");
    return;
  }
  const path = writeSetupToken(token, ctx);
  stdout.write(`setup-token 을 저장했습니다: ${path}\n`);
  stdout.write(`${DIM}이 토큰은 ~/.claude 에만 있고 auth.json 으로 복사하지 않습니다.${RST}\n`);
}

async function addStoredApiKey(providerId, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write(`${LOGIN_LABELS[providerId] ?? providerId} API 키를 붙여넣어 주세요. 그냥 Enter 를 누르면 취소됩니다.\n`);
  if (providerId === "kiro") stdout.write("키 대신 이 스크립트를 써도 됩니다: harness/scripts/kiro-setup.sh\n");
  if (providerId === "opencode") stdout.write("Keychain 서비스 opencode.ai 에 넣어 두어도 됩니다.\n");
  if (providerId === "b-ai") stdout.write("B.AI 키입니다. 모델은 DeepSeek V4.1 Flash.\n");
  const key = await readLine(ctx);
  if (!key) {
    stdout.write("취소했습니다.\n");
    return;
  }
  await storeApiKey(credentialsOf(ctx), providerId, key);
  stdout.write(`${LOGIN_LABELS[providerId] ?? providerId} API 키를 auth.json 에 저장했습니다.\n`);
}

export async function defaultLogin(providerId, method, ctx) {
  if (method === "setup-token") {
    await addSetupToken(ctx);
    return;
  }
  if (method === "api_key" && (providerId === "kiro" || providerId === "opencode" || providerId === "b-ai")) {
    await addStoredApiKey(providerId, ctx);
    return;
  }
  await runEngineLogin(providerId, method === "api_key" ? "api_key" : "oauth", ctx);
}

async function loginProvider(providerId, method, ctx) {
  const login = ctx.login ?? defaultLogin;
  await login(providerId, method, ctx);
}

function writeError(ctx, message) {
  (ctx.stdout ?? process.stdout).write(`${message}\n`);
}

export async function runLoginCommand(args, ctx) {
  const resolved = resolveLoginProvider(args[0]);
  if (!resolved || resolved.error === "unknown") {
    printUsage(ctx.stdout ?? process.stdout);
    if (resolved?.name) writeError(ctx, `Unknown provider: ${resolved.name}`);
    return "usage";
  }
  const method = resolveLoginMethod(resolved.id, args[1]);
  if (method.error) {
    writeError(ctx, `Unknown method for ${resolved.id}: ${args[1] ?? ""}`);
    writeError(ctx, `methods: ${method.methods.join(", ")}`);
    return "usage";
  }
  await loginProvider(resolved.id, method.id, ctx);
  return "ok";
}

async function runPinCommand(providerId, name, ctx) {
  await pinCredentialAccount(credentialsOf(ctx), providerId, name, ctx.env ?? {}, repositoryOf(ctx));
  (ctx.stdout ?? process.stdout).write(
    name === null ? `Unpinned ${providerId}.\n` : `Pinned ${providerId} account '${name}'.\n`,
  );
}

async function runRemoveCommand(providerId, name, ctx) {
  await removeCredentialAccount(credentialsOf(ctx), providerId, name, ctx.env ?? {}, repositoryOf(ctx));
  (ctx.stdout ?? process.stdout).write(`Removed ${providerId} account '${name}'.\n`);
}

async function resolveProviderArg(name, ctx) {
  const resolved = resolveLoginProvider(name);
  if (!resolved?.id) {
    writeError(ctx, `Unknown provider: ${name ?? ""}`);
    return undefined;
  }
  return resolved.id;
}

export async function handleAuthArgs(argv, ctx) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "login" || cmd === "add") return runLoginCommand(rest, ctx);
    if (cmd === "list") {
      if (!rest[0]) {
        await printStatus(ctx);
        return "ok";
      }
      const id = await resolveProviderArg(rest[0], ctx);
      if (!id) return "usage";
      await printProviderAccounts(id, ctx);
      return "ok";
    }
    if (cmd === "pin") {
      const id = await resolveProviderArg(rest[0], ctx);
      if (!id || rest[1] === undefined) return "usage";
      await runPinCommand(id, rest[1], ctx);
      return "ok";
    }
    if (cmd === "unpin") {
      const id = await resolveProviderArg(rest[0], ctx);
      if (!id) return "usage";
      await runPinCommand(id, null, ctx);
      return "ok";
    }
    if (cmd === "remove") {
      const id = await resolveProviderArg(rest[0], ctx);
      if (!id || rest[1] === undefined) return "usage";
      await runRemoveCommand(id, rest[1], ctx);
      return "ok";
    }
    return "usage";
  } catch (error) {
    writeError(ctx, error instanceof Error ? error.message : String(error));
    return "error";
  }
}

// ── 방향키 화면들 ────────────────────────────────────────────────────────────

export const METHOD_LABELS = Object.freeze({
  oauth: "브라우저로 로그인",
  api_key: "API 키 붙여넣기",
  "setup-token": "setup-token 붙여넣기 (sk-ant-oat…)",
});

const STATE_GLYPH = Object.freeze({
  connected: `${GRN}✓${RST}`,
  blocked: `${YEL}✗${RST}`,
  stale: `${YEL}✗${RST}`,
  absent: `${DIM}·${RST}`,
});

const NAV_HINT = `${DIM}↑↓ 이동 · Enter 선택 · Esc 뒤로 · q 종료${RST}`;

function separator(label = "") {
  return { separator: true, label: `${DIM}${label}${RST}` };
}

/** 로그인·붙여넣기처럼 줄 출력이 필요한 자리. 메뉴의 raw 모드를 잠시 놓는다. */
async function withPlainTerminal(ctx, fn) {
  const stdout = ctx.stdout ?? process.stdout;
  ctx.keys?.suspend();
  stdout.write(SHOW_CURSOR);
  try {
    return await fn();
  } finally {
    ctx.keys?.resume();
  }
}

async function pause(ctx, message) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write(`${message}\n${DIM}아무 키나 누르면 돌아갑니다.${RST}\n`);
  await ctx.keys?.next();
}

async function runGuarded(ctx, fn) {
  try {
    await withPlainTerminal(ctx, fn);
  } catch (error) {
    await pause(ctx, `${YEL}${error instanceof Error ? error.message : String(error)}${RST}`);
  }
}

/**
 * 성공 문구를 삼키고 돌리는 자리. 메뉴가 곧바로 다시 그려지면서 결과를 그대로
 * 보여 주므로(고정됨 표시, 사라진 계정), 확인 한 줄은 화면에 남는 찌꺼기일 뿐이다.
 * 실패는 예외로 올라오므로 `runGuarded` 가 그대로 보여 준다.
 */
function quietly(ctx) {
  return { ...ctx, stdout: { write() {} } };
}

function accountDetail(account) {
  const parts = [account.source, describeState(account.state)];
  if (account.pinned) parts.push("고정됨");
  return parts.join(" · ");
}

function untilDate(expires) {
  return typeof expires === "number" && expires > 0
    ? new Date(expires).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
    : "알 수 없음";
}

async function checkAccount(providerId, account, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  await runGuarded(ctx, async () => {
    stdout.write(`${account.name} 계정으로 실제 갱신을 한 번 시도합니다…\n`);
    const result = await verifyAccount(providerId, account.name, ctx);
    if (result.kind === "unsupported") {
      await pause(ctx, `${DIM}이 계정은 미리 확인할 방법이 없습니다. 실제로 써 봐야 알 수 있습니다.${RST}`);
      return;
    }
    if (result.kind === "stale") {
      await pause(ctx, `${YEL}갱신이 실패했고 지금 토큰도 만료됐습니다. 다시 로그인해 주세요.${RST}\n${DIM}${result.reason}${RST}`);
      return;
    }
    if (result.kind === "renew_failed") {
      await pause(ctx, [
        `${YEL}지금 토큰은 쓸 수 있지만 갱신이 되지 않습니다.${RST}`,
        `${DIM}${untilDate(result.expires)} 까지는 그대로 쓰이고, 그 뒤에는 다시 로그인해야 합니다.${RST}`,
        `${DIM}${result.reason}${RST}`,
      ].join("\n"));
      return;
    }
    await pause(ctx, `${GRN}연결됐습니다.${RST}${account.state === "blocked" ? " 차단 기록도 지웠습니다." : ""}`);
  });
}

async function accountScreen(providerId, account, ctx) {
  const spec = providerSpec(providerId);
  const removable = account.source !== "env" && account.source !== "setup-token";
  const items = [
    { label: "연결 확인", value: "check" },
    account.pinned
      ? { label: "고정 해제", value: "unpin" }
      : { label: "이 계정만 쓰도록 고정", value: "pin" },
    removable
      ? { label: "이 계정 삭제", value: "remove" }
      : { label: "여기서는 삭제할 수 없습니다 (원본 파일에서 관리합니다)", value: undefined, disabled: true },
    separator(),
    { label: "뒤로", value: BACK },
  ];
  const choice = await runMenu({
    stdout: ctx.stdout ?? process.stdout,
    keys: ctx.keys,
    title: `\n${BOLD}${spec?.label ?? providerId} / ${account.name}${RST}`,
    hint: NAV_HINT,
    items,
  });
  if (choice === QUIT) return QUIT;
  if (choice === BACK || choice === undefined) return BACK;
  if (choice === "check") await checkAccount(providerId, account, ctx);
  if (choice === "pin") await runGuarded(ctx, () => runPinCommand(providerId, account.name, quietly(ctx)));
  if (choice === "unpin") await runGuarded(ctx, () => runPinCommand(providerId, null, quietly(ctx)));
  if (choice === "remove") {
    const confirm = await runMenu({
      stdout: ctx.stdout ?? process.stdout,
      keys: ctx.keys,
      title: `\n${BOLD}'${account.name}' 계정을 삭제합니다. 되돌릴 수 없습니다.${RST}`,
      hint: NAV_HINT,
      items: [{ label: "취소", value: BACK }, { label: "삭제", value: "yes" }],
    });
    if (confirm === QUIT) return QUIT;
    if (confirm === "yes") await runGuarded(ctx, () => runRemoveCommand(providerId, account.name, quietly(ctx)));
  }
  return BACK;
}

async function providerScreen(providerId, ctx) {
  const spec = providerSpec(providerId);
  let index = 0;
  while (true) {
    const row = (await collectStatus(ctx)).find((candidate) => candidate.provider.id === providerId);
    const accounts = row?.accounts ?? [];
    const items = accounts.map((account) => ({
      label: account.name,
      detail: accountDetail(account),
      value: { kind: "account", account },
    }));
    if (items.length > 0) items.push(separator());
    for (const method of spec.methods) {
      items.push({ label: METHOD_LABELS[method] ?? method, value: { kind: "add", method } });
    }
    items.push(separator(), { label: "뒤로", value: BACK });
    const header = accounts.length === 0 ? [`  ${DIM}등록된 계정이 없습니다.${RST}`] : [];
    if (providerId === "anthropic" && !accounts.some((account) => account.source === "setup-token")) {
      header.push(`  ${DIM}setup-token 파일: ${claudeSetupTokenPath(ctx.env, ctx.home)} (계정 ${claudeAccount(ctx.env)})${RST}`);
    }
    const choice = await runMenu({
      stdout: ctx.stdout ?? process.stdout,
      keys: ctx.keys,
      title: `\n${BOLD}${spec.label}${RST}`,
      header,
      hint: NAV_HINT,
      items,
      index,
    });
    if (choice === QUIT) return QUIT;
    if (choice === BACK || choice === undefined) return BACK;
    index = items.findIndex((item) => item.value === choice);
    if (choice.kind === "add") {
      await runGuarded(ctx, () => loginProvider(providerId, choice.method, ctx));
      continue;
    }
    if (choice.kind === "account") {
      const result = await accountScreen(providerId, choice.account, ctx);
      if (result === QUIT) return QUIT;
    }
  }
}

async function runInteractive(ctx) {
  let index = 0;
  while (true) {
    const rows = await collectStatus(ctx);
    const items = rows.map((row) => ({
      label: `${STATE_GLYPH[row.state]} ${row.provider.label}`,
      detail: summaryOf(row),
      value: row.provider.id,
    }));
    items.push(separator(), { label: "종료", value: QUIT });
    const choice = await runMenu({
      stdout: ctx.stdout ?? process.stdout,
      keys: ctx.keys,
      title: `\n${BOLD}== rubato auth ==${RST}`,
      hint: NAV_HINT,
      items,
      index,
      quitOnBack: true,
    });
    if (choice === QUIT || choice === BACK || choice === undefined) return;
    index = items.findIndex((item) => item.value === choice);
    if (await providerScreen(choice, ctx) === QUIT) return;
  }
}

function withIo(io = {}) {
  const env = io.env ?? process.env;
  return {
    stdout: io.stdout ?? process.stdout,
    stdin: io.stdin ?? process.stdin,
    env,
    home: io.home ?? env.HOME ?? homedir(),
    interactive: io.interactive,
    readLine: io.readLine,
    keys: io.keys,
    login: io.login,
    credentials: io.credentials,
    repository: io.repository,
    openUrl: io.openUrl,
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const ctx = withIo(io);
  const stdout = ctx.stdout;
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printUsage(stdout);
    return;
  }
  if (argv[0] === "--status" || argv[0] === "status") {
    await printStatus(ctx);
    return;
  }
  if (argv.length === 0) {
    const interactive = ctx.interactive ?? Boolean(ctx.stdin?.isTTY);
    if (!interactive) {
      await printStatus(ctx);
      return;
    }
    const keys = ctx.keys ?? createKeyReader({ stdin: ctx.stdin ?? process.stdin });
    ctx.keys = keys;
    try {
      await runInteractive(ctx);
    } finally {
      stdout.write(SHOW_CURSOR);
      if (!io.keys) keys.close();
    }
    return;
  }
  const result = await handleAuthArgs(argv, ctx);
  if (result === "usage") {
    printUsage(stdout);
    process.exitCode = 2;
  } else if (result === "error") {
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
