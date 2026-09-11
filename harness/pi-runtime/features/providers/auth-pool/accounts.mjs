import { listSlots, pinSlot, removeSlot } from "./slots.mjs";
import { discoverEnvSlots } from "./env-slots.mjs";
import { CredentialSlotRepository, slotHealth } from "./state-store.mjs";

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidAccountName(name) {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`);
  }
}

function defaultRepository(poolStatePath) {
  return new CredentialSlotRepository(poolStatePath);
}

function slotBlocked(slot, sidecar, now) {
  if (slotHealth(sidecar, now) === "blocked") return true;
  if (slot.blockReason === "auth_error" || slot.blockReason === "account_disabled") return true;
  return typeof slot.blockedUntil === "number" && slot.blockedUntil > now;
}

export async function summarizeCredentialAccounts(provider, stored, env = {}, repository = new CredentialSlotRepository()) {
  const now = Date.now();
  const pinned = stored?.pinned;
  const summaries = [];
  if (stored) {
    const state = await repository.listSlots(provider, "stored");
    for (const slot of listSlots(stored)) {
      summaries.push({
        name: slot.name,
        source: slot.source ?? "login",
        blocked: slotBlocked(slot, state[slot.name], now),
        pinned: pinned === slot.name,
      });
    }
    return summaries;
  }
  const state = await repository.listSlots(provider, "env");
  for (const slot of discoverEnvSlots(provider, (name) => env[name])) {
    const persisted = state[slot.name];
    const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
    const applicable = persisted?.credentialRevision === revision ? persisted : undefined;
    summaries.push({
      name: slot.name,
      source: "env",
      blocked: slotHealth(applicable, now) === "blocked",
      pinned: pinned === slot.name,
    });
  }
  return summaries;
}

export async function getCredentialAccounts(credentials, provider, env = {}, repository) {
  const stored = await credentials.read(provider);
  return summarizeCredentialAccounts(provider, stored, env, repository ?? defaultRepository());
}

export async function pinCredentialAccount(credentials, provider, name, env = {}, repository) {
  const repo = repository ?? defaultRepository();
  if (name !== null) {
    assertValidAccountName(name);
    const accounts = await getCredentialAccounts(credentials, provider, env, repo);
    if (!accounts.some((account) => account.name === name)) {
      throw new Error(`Provider account not found: ${name}`);
    }
  }
  await credentials.modify(provider, async (current) => {
    if (current === undefined) throw new Error(`No stored credential for provider: ${provider}`);
    if (name === null) {
      if (current.pinned === undefined) return current;
      const { pinned: _pinned, ...unpinned } = current;
      return unpinned;
    }
    return pinSlot(current, name);
  });
}

export async function removeCredentialAccount(credentials, provider, name, env = {}, repository) {
  const repo = repository ?? defaultRepository();
  const accounts = await getCredentialAccounts(credentials, provider, env, repo);
  const account = accounts.find((candidate) => candidate.name === name);
  if (!account) throw new Error(`Provider account not found: ${name}`);
  if (account.source === "env") throw new Error(`Environment provider account cannot be removed: ${name}`);
  const current = await credentials.read(provider);
  if (current === undefined) throw new Error(`No stored credential for provider: ${provider}`);
  const remaining = removeSlot(current, name);
  if (remaining === undefined) await credentials.delete(provider);
  else await credentials.modify(provider, async () => remaining);
  await repo.mutateSlotState(provider, "stored", name, () => undefined);
}

function parseArgs(rawArgs) {
  return String(rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
}

function statusOf(account) {
  const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
  if (account.pinned) states.push("pinned");
  return states.join(" | ");
}

export function registerAccountCommand(pi, { credentials, env = {}, poolStatePath } = {}) {
  if (typeof pi?.registerCommand !== "function") return;
  const repository = new CredentialSlotRepository(poolStatePath);
  pi.registerCommand("account", {
    description: "List and manage credential accounts for any provider.",
    argumentHint: "<provider> [list | pin <name> | unpin | remove <name>]",
    handler: async (rawArgs, ctx) => {
      const store = credentials ?? ctx?.modelRegistry?.runtime?.credentials;
      const args = parseArgs(rawArgs);
      const provider = args[0];
      const notify = (message, kind = "info") => ctx?.ui?.notify?.(message, kind);
      if (provider === undefined) {
        notify("Usage: /account <provider> [list | pin <name> | unpin | remove <name>]", "error");
        return { text: "usage" };
      }
      const action = args[1] ?? "list";
      try {
        if (action === "list") {
          const accounts = await getCredentialAccounts(store, provider, env, repository);
          const lines = [`Credential accounts for ${provider}:`, ...(accounts.length === 0 ? ["  (none)"] : accounts.map((account) => `  ${statusOf(account)}`))];
          notify(lines.join("\n"));
          return { text: lines.join("\n"), accounts };
        }
        if (action === "pin" && args[2] !== undefined) {
          await pinCredentialAccount(store, provider, args[2], env, repository);
          notify(`Pinned ${provider} account '${args[2]}'.`);
          return { text: "pinned" };
        }
        if (action === "unpin") {
          await pinCredentialAccount(store, provider, null, env, repository);
          notify(`Unpinned ${provider} account.`);
          return { text: "unpinned" };
        }
        if (action === "remove" && args[2] !== undefined) {
          await removeCredentialAccount(store, provider, args[2], env, repository);
          notify(`Removed ${provider} account '${args[2]}'.`);
          return { text: "removed" };
        }
        notify("Usage: /account <provider> [list | pin <name> | unpin | remove <name>]", "error");
        return { text: "usage" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(message, "error");
        return { text: message };
      }
    },
  });
}
