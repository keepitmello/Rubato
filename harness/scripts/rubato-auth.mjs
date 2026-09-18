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
import { appendLoginSlot, listSlots } from "../pi-runtime/features/providers/auth-pool/slots.mjs";
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
 * 자격증명 한 칸의 상태. **계정마다 따로 센다.**
 *
 * 예전에는 provider 의 flat 필드(`auth.json` 맨 위 `access`/`expires`) 하나만 읽었다.
 * 두 번째 로그인은 `accounts[]` 에 슬롯으로 붙고 flat 은 첫 로그인 그대로 남으므로,
 * 방금 로그인한 계정이 멀쩡한데도 화면은 죽은 첫 계정을 읽고 "만료"를 찍었다.
 *
 * `renewable` 은 만료됐지만 refresh token 이 있는 상태다 — 런타임이 다음 호출에서
 * 스스로 갱신하므로 다시 로그인할 일이 아니다. 재로그인이 필요한 것은 `stale` 뿐이다.
 */
export function slotPresence(slot, now = Date.now()) {
  if (!slot || typeof slot !== "object") return { ok: false, state: "absent" };
  const access = typeof slot.access === "string" ? slot.access : "";
  const key = typeof slot.key === "string" ? slot.key : "";
  if (!access && !key) return { ok: false, state: "absent" };
  if (!access) return { ok: true, state: "key" };
  const expires = typeof slot.expires === "number" && slot.expires > 0 ? slot.expires : undefined;
  if (expires === undefined) return { ok: true, state: "key" };
  const leftMs = expires - now;
  if (leftMs > 0) return { ok: true, state: "live", leftMs };
  return typeof slot.refresh === "string" && slot.refresh
    ? { ok: true, state: "renewable" }
    : { ok: true, state: "stale" };
}

const STATE_RANK = Object.freeze({ live: 0, renewable: 1, key: 2, stale: 3, absent: 4 });

/** provider 한 줄에 쓸 요약. 가장 건강한 계정이 대표한다. */
export function credentialHealth(entry, extraSlots = [], now = Date.now()) {
  const slots = [...listSlots(entry), ...extraSlots];
  let best = { ok: false, state: "absent" };
  for (const slot of slots) {
    const presence = slot.source === "setup-token" ? { ok: true, state: "key" } : slotPresence(slot, now);
    if (STATE_RANK[presence.state] < STATE_RANK[best.state]) best = presence;
    else if (presence.state === "live" && best.state === "live" && presence.leftMs > best.leftMs) best = presence;
  }
  return { ...best, count: slots.length };
}

export function formatLeft(leftMs) {
  const minutes = Math.floor(leftMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}분 남음`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간 남음`;
  return `${Math.floor(hours / 24)}일 남음`;
}

export function describeHealth(health) {
  if (health.state === "live") return formatLeft(health.leftMs);
  if (health.state === "renewable") return "곧 자동 갱신";
  if (health.state === "key") return "저장됨";
  if (health.state === "stale") return "다시 로그인 필요";
  return "로그인 안 됨";
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

function storedSlotLines(entry, now = Date.now()) {
  if (!entry) return [];
  return listSlots(entry).map((slot) => {
    const pinned = entry.pinned === slot.name ? " | pinned" : "";
    return `${slot.name} | ${slot.source ?? "login"} | ${describeHealth(slotPresence(slot, now))}${pinned}`;
  });
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

/** provider 별 상태. TUI 목록과 `rubato auth status` 가 같은 계산을 쓴다. */
export function collectStatus({ env = process.env, home = env.HOME || homedir(), now = Date.now() } = {}) {
  const authPath = authJsonPath(env, home);
  const auth = existsSync(authPath) ? readAuthFile(authPath) : {};
  const tokenPath = setupTokenPresent({ env, home });
  return PROVIDERS.map((provider) => {
    const entry = auth[provider.id];
    const extra = provider.id === "anthropic" && tokenPath
      ? [{ name: "setup-token", source: "setup-token" }]
      : [];
    const health = credentialHealth(entry, extra, now);
    return {
      provider,
      health,
      lines: [...storedSlotLines(entry, now), ...extra.map((slot) => `${slot.name} | setup-token | 저장됨`)],
    };
  });
}

export function printStatus({ stdout = process.stdout, env = process.env, home = env.HOME || homedir() } = {}) {
  stdout.write(`\n${BOLD}== rubato auth ==${RST}\n`);
  collectStatus({ env, home }).forEach((row, index) => {
    const n = `${index + 1})`;
    const write = row.health.ok && row.health.state !== "stale" ? ok : miss;
    write(stdout, `${n} ${row.provider.label} — ${describeHealth(row.health)}`);
    if (!row.health.ok || row.health.state === "stale") hint(stdout, methodHint(row.provider.id));
    for (const line of row.lines) hint(stdout, line);
  });
  stdout.write(`${DIM}남은 시간은 액세스 토큰 기준이다. 만료돼도 refresh 가 있으면 자동으로 갱신된다.${RST}\n\n`);
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
    hint(stdout, `token file: ${claudeSetupTokenPath(ctx.env, ctx.home)}  (계정: ${claudeAccount(ctx.env)})`);
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
        const line = await readLineHere(prompt.signal);
        const asNumber = Number.parseInt(line, 10);
        if (Number.isInteger(asNumber) && prompt.options[asNumber - 1]) return prompt.options[asNumber - 1].id;
        const match = prompt.options.find((option) => option.id === line || option.label === line);
        if (match) return match.id;
        throw new Error(`Unknown login option: ${line}`);
      }
      stdout.write(`${prompt.message}\n`);
      return readLineHere(prompt.signal);
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

async function runEngineLogin(providerId, type, ctx) {
  const env = ctx.env ?? process.env;
  const stdout = ctx.stdout ?? process.stdout;
  const stdin = ctx.stdin ?? process.stdin;
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
  const openBrowser = ctx.openUrl ? undefined : await loadOpenBrowser(selection.root);
  const interaction = await createCliInteraction({
    stdin,
    stdout,
    openUrl: ctx.openUrl ?? ((url) => openBrowser(url)),
  });
  stdout.write(`Logging in to ${LOGIN_LABELS[providerId] ?? providerId} (${type})…\n`);
  try {
    await loginWithRuntime(runtime, providerId, type, interaction);
  } finally {
    interaction.close?.();
  }
  stdout.write(`Logged in. Credentials: ${authJsonPath(env, ctx.home)}\n`);
}

async function addSetupToken(ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write("Paste a sk-ant-oat… token (empty cancels).\n");
  stdout.write(`Or run: claude setup-token\n`);
  const existing = setupTokenPresent(ctx);
  if (existing) stdout.write(`Replace existing file: ${existing}\n`);
  const token = await readLine(ctx);
  if (!token) {
    stdout.write("Cancelled.\n");
    return;
  }
  const path = writeSetupToken(token, ctx);
  stdout.write(`Saved setup-token: ${path}\n`);
  stdout.write(`${DIM}This stays in ~/.claude. It is not copied into auth.json.${RST}\n`);
}

async function addStoredApiKey(providerId, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write(`Paste the API key for ${LOGIN_LABELS[providerId] ?? providerId} (empty cancels).\n`);
  if (providerId === "kiro") stdout.write("Or run: harness/scripts/kiro-setup.sh\n");
  if (providerId === "opencode") stdout.write("Or store it in Keychain service opencode.ai\n");
  const key = await readLine(ctx);
  if (!key) {
    stdout.write("Cancelled.\n");
    return;
  }
  await storeApiKey(credentialsOf(ctx), providerId, key);
  stdout.write(`Saved ${LOGIN_LABELS[providerId] ?? providerId} API key in auth.json.\n`);
}

export async function defaultLogin(providerId, method, ctx) {
  if (method === "setup-token") {
    await addSetupToken(ctx);
    return;
  }
  if (method === "api_key" && (providerId === "kiro" || providerId === "opencode")) {
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
        printStatus(ctx);
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

const HEALTH_GLYPH = Object.freeze({ live: `${GRN}✓${RST}`, renewable: `${GRN}✓${RST}`, key: `${GRN}✓${RST}`, stale: `${YEL}✗${RST}`, absent: `${DIM}·${RST}` });

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
  stdout.write(`${message}\n${DIM}아무 키나 누르면 돌아간다.${RST}\n`);
  await ctx.keys?.next();
}

async function runGuarded(ctx, fn) {
  try {
    await withPlainTerminal(ctx, fn);
  } catch (error) {
    await pause(ctx, `${YEL}${error instanceof Error ? error.message : String(error)}${RST}`);
  }
}

function accountDetail(account, slotByName, now) {
  const parts = [account.source];
  const slot = slotByName.get(account.name);
  parts.push(account.source === "setup-token" ? "저장됨" : describeHealth(slotPresence(slot, now)));
  if (account.pinned) parts.push("고정됨");
  if (account.blocked) parts.push("차단됨");
  return parts.join(" · ");
}

async function accountScreen(providerId, account, ctx) {
  const spec = providerSpec(providerId);
  const removable = account.source !== "env" && account.source !== "setup-token";
  const items = [
    account.pinned
      ? { label: "고정 해제", value: "unpin" }
      : { label: "이 계정만 쓰도록 고정", value: "pin" },
    removable
      ? { label: "이 계정 삭제", value: "remove" }
      : { label: "삭제할 수 없음 (파일이 원본이다)", value: undefined, disabled: true },
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
  if (choice === "pin") await runGuarded(ctx, () => runPinCommand(providerId, account.name, ctx));
  if (choice === "unpin") await runGuarded(ctx, () => runPinCommand(providerId, null, ctx));
  if (choice === "remove") {
    const confirm = await runMenu({
      stdout: ctx.stdout ?? process.stdout,
      keys: ctx.keys,
      title: `\n${BOLD}'${account.name}' 을 지운다. 되돌릴 수 없다.${RST}`,
      hint: NAV_HINT,
      items: [{ label: "그대로 둔다", value: BACK }, { label: "지운다", value: "yes" }],
    });
    if (confirm === QUIT) return QUIT;
    if (confirm === "yes") await runGuarded(ctx, () => runRemoveCommand(providerId, account.name, ctx));
  }
  return BACK;
}

async function providerScreen(providerId, ctx) {
  const spec = providerSpec(providerId);
  let index = 0;
  while (true) {
    const now = Date.now();
    const entry = await credentialsOf(ctx).read(providerId);
    const slotByName = new Map(listSlots(entry).map((slot) => [slot.name, slot]));
    const accounts = await listProviderAccounts(providerId, ctx);
    const items = accounts.map((account) => ({
      label: account.name,
      detail: accountDetail(account, slotByName, now),
      value: { kind: "account", account },
    }));
    if (items.length > 0) items.push(separator());
    for (const method of spec.methods) {
      items.push({ label: METHOD_LABELS[method] ?? method, value: { kind: "add", method } });
    }
    items.push(separator(), { label: "뒤로", value: BACK });
    const header = accounts.length === 0 ? [`  ${DIM}등록된 계정이 없다.${RST}`] : [];
    if (providerId === "anthropic" && !accounts.some((account) => account.source === "setup-token")) {
      header.push(`  ${DIM}setup-token 자리: ${claudeSetupTokenPath(ctx.env, ctx.home)} (계정 ${claudeAccount(ctx.env)})${RST}`);
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
    const rows = collectStatus({ env: ctx.env, home: ctx.home });
    const items = rows.map((row) => ({
      label: `${HEALTH_GLYPH[row.health.state]} ${row.provider.label}`,
      detail: `${describeHealth(row.health)}${row.health.count > 1 ? ` · 계정 ${row.health.count}` : ""}`,
      value: row.provider.id,
    }));
    items.push(separator(), { label: "종료", value: QUIT });
    const choice = await runMenu({
      stdout: ctx.stdout ?? process.stdout,
      keys: ctx.keys,
      title: `\n${BOLD}== rubato auth ==${RST}`,
      header: [`  ${DIM}남은 시간은 액세스 토큰 기준이다. 만료돼도 자동으로 갱신된다.${RST}`],
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
    printStatus(ctx);
    return;
  }
  if (argv.length === 0) {
    const interactive = ctx.interactive ?? Boolean(ctx.stdin?.isTTY);
    if (!interactive) {
      printStatus(ctx);
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
