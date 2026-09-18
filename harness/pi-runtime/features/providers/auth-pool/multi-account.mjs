import { join } from "node:path";
import { getCredentialAccounts, pinCredentialAccount, removeCredentialAccount } from "./accounts.mjs";
import { CredentialSlotRepository } from "./state-store.mjs";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const MULTI_ACCOUNT_FACTORY_NAME = "rubato-multi-account";
export const GPT_ACCOUNT_FACTORY_NAME = "rubato-gpt-account";
export const MULTI_ACCOUNT_COMMAND = "multi-account";
export const GPT_ACCOUNT_COMMAND = "gpt-account";
const LOGIN_CANCELLED_MESSAGE = "Login cancelled";
const LIST_PROVIDERS = Object.freeze([
  "openai-codex",
  "anthropic",
  "xai",
  "cursor",
  "google-antigravity",
  "opencode",
  "kiro",
]);
const CHOICE_CLOSE = "닫기";
const CHOICE_BACK = "뒤로";
const CHOICE_ADD = "계정 추가";
const CHOICE_AUTO = "자동으로 나누기";

function parseArgs(rawArgs) {
  return String(rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
}

function usage(ctx) {
  notify(ctx, "Usage: /multi-account [<provider>] [list | add | remove <name> | pin <name> | unpin]", "error");
}

function notify(ctx, message, kind = "info") {
  ctx?.ui?.notify?.(message, kind);
}

function credentialsOf(ctx, fallback) {
  return fallback ?? ctx?.modelRegistry?.runtime?.credentials;
}

function runtimeOf(ctx) {
  return ctx?.modelRegistry?.runtime ?? ctx?.modelRegistry?.modelRuntime;
}

function providerLabel(provider) {
  if (provider === OPENAI_CODEX_PROVIDER_ID) return "OpenAI Codex";
  if (provider === ANTHROPIC_PROVIDER_ID) return "Anthropic";
  return provider;
}

function canSelect(ctx) {
  return Boolean(ctx?.hasUI && typeof ctx.ui?.select === "function");
}

function accountChoice(account) {
  const tag = account.pinned ? "쓰는 중" : account.blocked ? "막힘" : account.source;
  return `${account.name}  (${tag})`;
}

function providerChoice(id, accounts) {
  const pinned = accounts.find((account) => account.pinned);
  const extra = accounts.length === 0
    ? "없음"
    : pinned
      ? `${accounts.length} · ${pinned.name}`
      : String(accounts.length);
  return `${providerLabel(id)}  (${extra})`;
}

function authEventMessage(provider, event) {
  const label = providerLabel(provider);
  if (event === null || typeof event !== "object") return `${label} OAuth authentication update.`;
  if (event.type === "auth_url" && typeof event.url === "string") {
    return `Open this URL to authorize ${label} OAuth:\n${event.url}`;
  }
  if (event.type === "device_code" && typeof event.verificationUri === "string") {
    return `Open this URL to authorize ${label} OAuth:\n${event.verificationUri}`;
  }
  return typeof event.message === "string" ? event.message : `${label} OAuth authentication update.`;
}

function formatAccounts(provider, accounts) {
  const lines = [`${providerLabel(provider)} accounts:`];
  if (accounts.length === 0) lines.push("  (none)");
  for (const account of accounts) {
    const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
    if (account.pinned) states.push("pinned");
    lines.push(`  ${states.join(" | ")}`);
  }
  return lines;
}

async function showProviderAccounts(ctx, store, provider, env, repository) {
  const accounts = await getCredentialAccounts(store, provider, env, repository);
  const lines = formatAccounts(provider, accounts);
  notify(ctx, lines.join("\n"));
  return { text: lines.join("\n"), provider, accounts };
}

async function showAllAccounts(ctx, store, env, repository) {
  const sections = [];
  const byProvider = {};
  for (const provider of LIST_PROVIDERS) {
    const accounts = await getCredentialAccounts(store, provider, env, repository);
    if (accounts.length === 0) continue;
    byProvider[provider] = accounts;
    sections.push(...formatAccounts(provider, accounts));
  }
  if (sections.length === 0) sections.push("Multi-account pool:", "  (none)");
  notify(ctx, sections.join("\n"));
  return { text: sections.join("\n"), accountsByProvider: byProvider };
}

async function addAccount(ctx, runtime, provider) {
  if (!ctx?.hasUI) {
    notify(ctx, `/multi-account ${provider} add requires an interactive UI.`, "error");
    return { text: "no-ui" };
  }
  try {
    await runtime.login(provider, "oauth", {
      signal: ctx.signal,
      prompt: async (prompt) => {
        const answer = await ctx.ui.input(prompt.message);
        if (answer === undefined) throw new Error(LOGIN_CANCELLED_MESSAGE);
        return answer;
      },
      notify: (event) => notify(ctx, authEventMessage(provider, event)),
    });
    notify(ctx, `${providerLabel(provider)} OAuth account added.`);
    return { text: "added" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === LOGIN_CANCELLED_MESSAGE) return { text: "cancelled" };
    notify(ctx, message, "error");
    return { text: message };
  }
}

async function pinNamed(ctx, store, provider, name, env, repository) {
  await pinCredentialAccount(store, provider, name, env, repository);
  notify(ctx, `${providerLabel(provider)} → ${name}`);
  return { text: "pinned" };
}

async function unpinNamed(ctx, store, provider, env, repository) {
  await pinCredentialAccount(store, provider, null, env, repository);
  notify(ctx, `${providerLabel(provider)} 자동으로 나눈다.`);
  return { text: "unpinned" };
}

async function runProviderPicker(ctx, store, runtime, env, repository, provider) {
  while (true) {
    const accounts = await getCredentialAccounts(store, provider, env, repository);
    const options = [
      ...accounts.map((account) => accountChoice(account)),
      CHOICE_ADD,
      ...(accounts.some((account) => account.pinned) ? [CHOICE_AUTO] : []),
      CHOICE_BACK,
    ];
    const choice = await ctx.ui.select(providerLabel(provider), options);
    if (choice === undefined || choice === CHOICE_BACK) return "back";
    if (choice === CHOICE_ADD) return addAccount(ctx, runtime, provider);
    if (choice === CHOICE_AUTO) return unpinNamed(ctx, store, provider, env, repository);
    const account = accounts.find((entry) => accountChoice(entry) === choice);
    if (!account) return { text: "ok" };
    if (account.pinned) {
      notify(ctx, `${providerLabel(provider)} 이미 ${account.name}`);
      return { text: "pinned" };
    }
    return pinNamed(ctx, store, provider, account.name, env, repository);
  }
}

async function runAccountPicker(ctx, store, runtime, env, repository, startProvider) {
  let provider = startProvider;
  if (!provider && ctx?.model?.provider && LIST_PROVIDERS.includes(ctx.model.provider)) {
    const current = await getCredentialAccounts(store, ctx.model.provider, env, repository);
    if (current.length > 1) provider = ctx.model.provider;
  }
  while (true) {
    if (!provider) {
      const rows = [];
      for (const id of LIST_PROVIDERS) {
        const accounts = await getCredentialAccounts(store, id, env, repository);
        rows.push({ id, label: providerChoice(id, accounts) });
      }
      const choice = await ctx.ui.select("계정", [...rows.map((row) => row.label), CHOICE_CLOSE]);
      if (choice === undefined || choice === CHOICE_CLOSE) return { text: "ok" };
      provider = rows.find((row) => row.label === choice)?.id;
      if (!provider) return { text: "ok" };
    }
    const result = await runProviderPicker(ctx, store, runtime, env, repository, provider);
    if (result === "back") {
      if (startProvider) return { text: "ok" };
      provider = undefined;
      continue;
    }
    return result;
  }
}

function resolveCommand(commandName, rawArgs) {
  const args = parseArgs(rawArgs);
  if (commandName === GPT_ACCOUNT_COMMAND) {
    return { provider: OPENAI_CODEX_PROVIDER_ID, args };
  }
  if (args[0] && LIST_PROVIDERS.includes(args[0])) {
    return { provider: args[0], args: args.slice(1) };
  }
  return { provider: undefined, args };
}

async function handleAccountAction({ commandName, rawArgs, ctx, store, runtime, env, repository }) {
  const resolved = resolveCommand(commandName, rawArgs);
  const action = resolved.args[0] ?? "list";
  const provider = resolved.provider;
  if (action === "list") {
    if (canSelect(ctx) && resolved.args[0] !== "list") {
      return runAccountPicker(ctx, store, runtime, env, repository, provider);
    }
    return provider
      ? showProviderAccounts(ctx, store, provider, env, repository)
      : showAllAccounts(ctx, store, env, repository);
  }
  if (!provider) {
    usage(ctx);
    return { text: "usage" };
  }
  if (action === "add") return addAccount(ctx, runtime, provider);
  if (action === "remove") {
    if (!resolved.args[1]) { usage(ctx); return { text: "usage" }; }
    await removeCredentialAccount(store, provider, resolved.args[1], env, repository);
    notify(ctx, `Removed ${providerLabel(provider)} account '${resolved.args[1]}'.`);
    return { text: "removed" };
  }
  if (action === "pin" && resolved.args[1] !== "unpin") {
    if (!resolved.args[1]) { usage(ctx); return { text: "usage" }; }
    await pinCredentialAccount(store, provider, resolved.args[1], env, repository);
    notify(ctx, `Pinned ${providerLabel(provider)} account '${resolved.args[1]}'.`);
    return { text: "pinned" };
  }
  if (action === "unpin" || (action === "pin" && resolved.args[1] === "unpin")) {
    await pinCredentialAccount(store, provider, null, env, repository);
    notify(ctx, `Unpinned ${providerLabel(provider)} account.`);
    return { text: "unpinned" };
  }
  usage(ctx);
  return { text: "usage" };
}

export function registerMultiAccountCommand(pi, { credentials, env = {}, poolStatePath } = {}) {
  if (typeof pi?.registerCommand !== "function") return;
  const repository = new CredentialSlotRepository(poolStatePath);
  const handlerFor = (commandName) => async (rawArgs, ctx) => {
    const store = credentialsOf(ctx, credentials);
    const runtime = runtimeOf(ctx);
    try {
      return await handleAccountAction({ commandName, rawArgs, ctx, store, runtime, env, repository });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, message, "error");
      return { text: message };
    }
  };
  pi.registerCommand(MULTI_ACCOUNT_COMMAND, {
    description: "Pick a provider account. Opens a list in the app.",
    argumentHint: "",
    handler: handlerFor(MULTI_ACCOUNT_COMMAND),
  });
  pi.registerCommand(GPT_ACCOUNT_COMMAND, {
    description: "OpenAI Codex alias for /multi-account.",
    argumentHint: "",
    handler: handlerFor(GPT_ACCOUNT_COMMAND),
  });
}

export function createMultiAccountExtension(options = {}) {
  const env = options.env ?? {};
  const agentDir = options.agentDir ?? env.RUBATO_PI_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR;
  const poolStatePath = options.poolStatePath
    ?? (typeof agentDir === "string" && agentDir.length > 0 ? join(agentDir, "credential-pool-state.json") : undefined);
  return async (pi) => {
    registerMultiAccountCommand(pi, { ...options, env, poolStatePath });
  };
}

export const registerGptAccountCommand = registerMultiAccountCommand;
export const createGptAccountExtension = createMultiAccountExtension;
