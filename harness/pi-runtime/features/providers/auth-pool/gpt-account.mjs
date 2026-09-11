import { join } from "node:path";
import { getCredentialAccounts, pinCredentialAccount, removeCredentialAccount } from "./accounts.mjs";
import { CredentialSlotRepository } from "./state-store.mjs";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const GPT_ACCOUNT_FACTORY_NAME = "rubato-gpt-account";
const LOGIN_CANCELLED_MESSAGE = "Login cancelled";

function parseArgs(rawArgs) {
  return String(rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
}

function usage(ctx) {
  notify(ctx, "Usage: /gpt-account [add | remove <name> | pin <name> | unpin]", "error");
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

function authEventMessage(event) {
  if (event === null || typeof event !== "object") return "OpenAI Codex OAuth authentication update.";
  if (event.type === "auth_url" && typeof event.url === "string") {
    return `Open this URL to authorize OpenAI Codex OAuth:\n${event.url}`;
  }
  if (event.type === "device_code" && typeof event.verificationUri === "string") {
    return `Open this URL to authorize OpenAI Codex OAuth:\n${event.verificationUri}`;
  }
  return typeof event.message === "string" ? event.message : "OpenAI Codex OAuth authentication update.";
}

async function showAccounts(ctx, store, env, repository) {
  const accounts = await getCredentialAccounts(store, OPENAI_CODEX_PROVIDER_ID, env, repository);
  const lines = ["OpenAI Codex OAuth accounts:"];
  if (accounts.length === 0) lines.push("  (none)");
  for (const account of accounts) {
    const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
    if (account.pinned) states.push("pinned");
    lines.push(`  ${states.join(" | ")}`);
  }
  notify(ctx, lines.join("\n"));
  return { text: lines.join("\n"), accounts };
}

async function addAccount(ctx, runtime) {
  if (!ctx?.hasUI) {
    notify(ctx, "/gpt-account add requires an interactive UI.", "error");
    return { text: "no-ui" };
  }
  try {
    await runtime.login(OPENAI_CODEX_PROVIDER_ID, "oauth", {
      signal: ctx.signal,
      prompt: async (prompt) => {
        const answer = await ctx.ui.input(prompt.message);
        if (answer === undefined) throw new Error(LOGIN_CANCELLED_MESSAGE);
        return answer;
      },
      notify: (event) => notify(ctx, authEventMessage(event)),
    });
    notify(ctx, "OpenAI Codex OAuth account added.");
    return { text: "added" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === LOGIN_CANCELLED_MESSAGE) return { text: "cancelled" };
    notify(ctx, message, "error");
    return { text: message };
  }
}

export function registerGptAccountCommand(pi, { credentials, env = {}, poolStatePath } = {}) {
  if (typeof pi?.registerCommand !== "function") return;
  const repository = new CredentialSlotRepository(poolStatePath);
  pi.registerCommand("gpt-account", {
    description: "List and manage OpenAI Codex OAuth accounts.",
    argumentHint: "[add | remove <name> | pin <name> | unpin]",
    handler: async (rawArgs, ctx) => {
      const store = credentialsOf(ctx, credentials);
      const runtime = runtimeOf(ctx);
      const args = parseArgs(rawArgs);
      const action = args[0] ?? "list";
      try {
        if (action === "list") return await showAccounts(ctx, store, env, repository);
        if (action === "add") return await addAccount(ctx, runtime);
        if (action === "remove") {
          if (!args[1]) { usage(ctx); return { text: "usage" }; }
          await removeCredentialAccount(store, OPENAI_CODEX_PROVIDER_ID, args[1], env, repository);
          notify(ctx, `Removed OpenAI Codex OAuth account '${args[1]}'.`);
          return { text: "removed" };
        }
        if (action === "pin" && args[1] !== "unpin") {
          if (!args[1]) { usage(ctx); return { text: "usage" }; }
          await pinCredentialAccount(store, OPENAI_CODEX_PROVIDER_ID, args[1], env, repository);
          notify(ctx, `Pinned OpenAI Codex OAuth account '${args[1]}'.`);
          return { text: "pinned" };
        }
        if (action === "unpin" || (action === "pin" && args[1] === "unpin")) {
          await pinCredentialAccount(store, OPENAI_CODEX_PROVIDER_ID, null, env, repository);
          notify(ctx, "Unpinned OpenAI Codex OAuth account.");
          return { text: "unpinned" };
        }
        usage(ctx);
        return { text: "usage" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, message, "error");
        return { text: message };
      }
    },
  });
}
export function createGptAccountExtension(options = {}) {
  const env = options.env ?? {};
  const agentDir = options.agentDir ?? env.RUBATO_PI_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR;
  const poolStatePath = options.poolStatePath
    ?? (typeof agentDir === "string" && agentDir.length > 0 ? join(agentDir, "credential-pool-state.json") : undefined);
  return async (pi) => {
    registerGptAccountCommand(pi, { ...options, env, poolStatePath });
  };
}
