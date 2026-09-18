#!/usr/bin/env node
// `rubato auth` — 상태, 인터랙티브 로그인, 여러 계정 등록.
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

function storedSlotLines(entry) {
  if (!entry) return [];
  return listSlots(entry).map((slot) => {
    const pinned = entry.pinned === slot.name ? " | pinned" : "";
    return `${slot.name} | ${slot.source ?? "login"}${pinned}`;
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

export function printStatus({ stdout = process.stdout, env = process.env, home = env.HOME || homedir() } = {}) {
  const authPath = authJsonPath(env, home);
  const auth = existsSync(authPath) ? readAuthFile(authPath) : {};
  const tokenPath = setupTokenPresent({ env, home });
  stdout.write(`\n${BOLD}== rubato auth ==${RST}\n`);
  PROVIDERS.forEach((provider, index) => {
    const entry = auth[provider.id];
    const presence = oauthPresence(entry);
    const slots = storedSlotLines(entry);
    const extra = [];
    if (provider.id === "anthropic" && tokenPath) extra.push(`setup-token | setup-token`);
    const connected = presence.ok || extra.length > 0;
    const n = `${index + 1})`;
    if (!connected) {
      miss(stdout, `${n} ${provider.label} — 없다`);
      hint(stdout, methodHint(provider.id));
      return;
    }
    if (presence.left === "expired" && extra.length === 0) {
      miss(stdout, `${n} ${provider.label} — 토큰이 만료됐다`);
      hint(stdout, methodHint(provider.id));
    } else if (presence.left && presence.left !== "expired") {
      ok(stdout, `${n} ${provider.label}  (남은 시간 ~${presence.left}${slots.length > 1 ? `, ${slots.length} accounts` : ""})`);
    } else {
      const count = slots.length + extra.length;
      ok(stdout, `${n} ${provider.label}${count > 1 ? `  (${count} accounts)` : ""}`);
    }
    for (const line of slots) hint(stdout, line);
    for (const line of extra) hint(stdout, line);
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

function printInteractiveHelp(stdout) {
  stdout.write(`${DIM}  [1-${PROVIDERS.length}] provider   login <id> [oauth|token|key]\n`);
  stdout.write(`  pin <id> <name>   unpin <id>   remove <id> <name>\n`);
  stdout.write(`  q quit   ? help${RST}\n\n`);
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
  const openBrowser = ctx.openUrl ? undefined : await loadOpenBrowser(selection.root);
  const interaction = await createCliInteraction({
    stdin,
    stdout,
    openUrl: ctx.openUrl ?? ((url) => openBrowser(url)),
  });
  stdout.write(`Logging in to ${LOGIN_LABELS[providerId] ?? providerId} (${type})…\n`);
  await loginWithRuntime(runtime, providerId, type, interaction);
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

function parseLine(line) {
  return String(line ?? "").trim().split(/\s+/).filter(Boolean);
}

async function chooseMethod(spec, ctx) {
  if (spec.methods.length === 1) return spec.methods[0];
  const stdout = ctx.stdout ?? process.stdout;
  spec.methods.forEach((method, index) => {
    stdout.write(`  ${index + 1}) ${method}\n`);
  });
  const line = await readLine(ctx);
  const asNumber = Number.parseInt(line, 10);
  if (Number.isInteger(asNumber) && spec.methods[asNumber - 1]) return spec.methods[asNumber - 1];
  const resolved = resolveLoginMethod(spec.id, line);
  if (resolved.id) return resolved.id;
  throw new Error(`Unknown method: ${line}`);
}

function printProviderMenu(spec, ctx) {
  const stdout = ctx.stdout ?? process.stdout;
  stdout.write(`  a) add (${spec.methods.join(" / ")})\n`);
  if (spec.methods.includes("setup-token")) stdout.write("  t) setup-token\n");
  if (spec.methods.includes("api_key") && spec.methods.includes("oauth")) stdout.write("  k) API key\n");
  stdout.write("  p <name> pin   r <name> remove   b back\n");
}

async function enterProvider(providerId, ctx) {
  const spec = providerSpec(providerId);
  const accounts = await printProviderAccounts(providerId, ctx);
  if (accounts.length === 0 && spec.methods.length === 1) {
    await loginProvider(providerId, spec.methods[0], ctx);
    return;
  }
  if (accounts.length === 0) {
    const method = await chooseMethod(spec, ctx);
    await loginProvider(providerId, method, ctx);
    return;
  }
  printProviderMenu(spec, ctx);
  const line = await readLine(ctx);
  const args = parseLine(line);
  const action = (args[0] ?? "").toLowerCase();
  if (!action || action === "b" || action === "back") return;
  if (action === "a" || action === "add") {
    const method = args[1] ? resolveLoginMethod(providerId, args[1]).id : await chooseMethod(spec, ctx);
    if (!method) throw new Error(`Unknown method: ${args[1]}`);
    await loginProvider(providerId, method, ctx);
    return;
  }
  if (action === "t" || action === "token") {
    await loginProvider(providerId, "setup-token", ctx);
    return;
  }
  if (action === "k" || action === "key") {
    await loginProvider(providerId, "api_key", ctx);
    return;
  }
  const typedMethod = resolveLoginMethod(providerId, action);
  if (typedMethod.id && args.length === 1) {
    await loginProvider(providerId, typedMethod.id, ctx);
    return;
  }
  if ((action === "p" || action === "pin") && args[1]) {
    await runPinCommand(providerId, args[1], ctx);
    return;
  }
  if ((action === "r" || action === "remove") && args[1]) {
    await runRemoveCommand(providerId, args[1], ctx);
    return;
  }
  writeError(ctx, `Unknown action: ${line}`);
}

export async function handleAuthLine(line, ctx) {
  const args = parseLine(line);
  if (args.length === 0) {
    printStatus(ctx);
    return "ok";
  }
  const head = args[0].toLowerCase();
  if (head === "q" || head === "quit" || head === "exit") return "quit";
  if (head === "?" || head === "help") {
    printUsage(ctx.stdout ?? process.stdout);
    printInteractiveHelp(ctx.stdout ?? process.stdout);
    return "ok";
  }
  if (head === "status") {
    printStatus(ctx);
    return "ok";
  }
  const asNumber = Number.parseInt(head, 10);
  if (String(asNumber) === head && PROVIDERS[asNumber - 1]) {
    await enterProvider(PROVIDERS[asNumber - 1].id, ctx);
    return "ok";
  }
  const asProvider = resolveLoginProvider(head);
  if (asProvider?.id && args.length === 1) {
    await enterProvider(asProvider.id, ctx);
    return "ok";
  }
  return handleAuthArgs(args, ctx);
}

async function runInteractive(ctx) {
  printInteractiveHelp(ctx.stdout ?? process.stdout);
  while (true) {
    const line = await readLine(ctx);
    const result = await handleAuthLine(line, ctx);
    if (result === "quit") return;
    if (result === "usage") printUsage(ctx.stdout ?? process.stdout);
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
    printStatus(ctx);
    const interactive = ctx.interactive ?? Boolean(ctx.stdin?.isTTY);
    if (interactive) await runInteractive(ctx);
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
