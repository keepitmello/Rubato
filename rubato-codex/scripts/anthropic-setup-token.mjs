// Hand OpenCodex the Claude long-lived setup-token that already lives on this machine.
//
// Without an Anthropic login OpenCodex still advertises `anthropic/*` rows, and selecting one
// does not fail — it hangs, because an unauthenticated provider never answers. A machine whose
// Codex default model is an `anthropic/*` slug therefore looks broken from the first launch.
// `ocx login anthropic` does not solve it either: its local import reads the Claude Code OAuth
// pair (Keychain `Claude Code-credentials`) and does not know about setup-tokens at all.
//
// Nothing here leaves the machine. We read a credential the operator already stored and write it
// into the credential store of a proxy that runs on the same host.
import { access, mkdir, readFile, stat, writeFile, rename, chmod } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Prefix of a setup-token. A value without it is a different kind of credential. */
export const CLAUDE_SETUP_TOKEN_PREFIX = "sk-ant-oat";

/** Account suffix Rubato's installer and auth script both use. */
export const DEFAULT_CLAUDE_ACCOUNT = "sub";

/**
 * How long an imported setup-token is treated as live.
 *
 * These tokens carry no refresh half, so OpenCodex's gate ("use the stored access token while
 * `expires` is in the future") is the only thing that decides whether it gets used. Setting the
 * window too short retires a perfectly good credential into a login prompt; too long only means
 * the upstream 401 surfaces instead, which is the same place an expired token lands anyway.
 * Anthropic issues these for a year, so a year from issuance is the honest estimate.
 */
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

function validToken(text) {
  const token = typeof text === "string" ? text.trim() : "";
  return token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length
    ? token
    : undefined;
}

export function claudeSetupTokenService(account) {
  return `Claude Code-setup-token-${account}`;
}

export function claudeSetupTokenPath(env = process.env, home = homedir()) {
  const explicit = env.RUBATO_CLAUDE_SETUP_TOKEN_FILE || env.FX_CLAUDE_SETUP_TOKEN_FILE;
  if (explicit) return explicit;
  const account = env.RUBATO_CLAUDE_ACCOUNT || env.FX_CLAUDE_ACCOUNT || DEFAULT_CLAUDE_ACCOUNT;
  return join(home, ".claude", "auth", `setup-token-${account}`);
}

function keychainToken(account, env) {
  if (process.platform !== "darwin") return undefined;
  try {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", claudeSetupTokenService(account), "-a", env.USER ?? "", "-w"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (result.error || result.status !== 0) return undefined;
    return validToken(result.stdout);
  } catch {
    // A machine without the Keychain tool is "no token here", never an install failure.
    return undefined;
  }
}

/**
 * Find the setup-token: file first, then Keychain.
 *
 * Absence is not an error. A machine that never ran `claude setup-token` simply keeps the
 * `ocx login anthropic` next step, and every other provider installs normally. `issuedAt` comes
 * from the file's mtime when we have one, because that is the closest thing to an issue date
 * available locally.
 */
export async function readClaudeSetupToken({ env = process.env, home = homedir(), now = Date.now } = {}) {
  const account = env.RUBATO_CLAUDE_ACCOUNT || env.FX_CLAUDE_ACCOUNT || DEFAULT_CLAUDE_ACCOUNT;
  const path = claudeSetupTokenPath(env, home);
  try {
    const token = validToken(await readFile(path, "utf8"));
    if (token) {
      let issuedAt = now();
      try { issuedAt = (await stat(path)).mtimeMs; } catch { /* mtime is a bonus, not a requirement */ }
      return { token, source: "file", issuedAt };
    }
  } catch {
    // Missing or unreadable file: fall through to the Keychain.
  }
  const fromKeychain = keychainToken(account, env);
  return fromKeychain ? { token: fromKeychain, source: "keychain", issuedAt: now() } : undefined;
}

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

/**
 * Write the token into OpenCodex's credential store as an Anthropic OAuth account.
 *
 * The adapter sends `Authorization: Bearer <access>` plus the Claude Code beta header whenever
 * `authMode` is `oauth`, which is exactly the shape a setup-token expects, so it belongs in the
 * `access` slot rather than as an API key (an API key would take the `x-api-key` path and be
 * rejected). `accountId` is filled because OpenCodex derives account identity from
 * `accountId ?? email ?? refresh`, and our refresh half is empty.
 */
export async function configureOpenCodexAnthropicAuth(setup, options = {}) {
  if (!setup?.selectedProviders?.includes("anthropic")) return { status: "not-selected" };
  const opencodexHome = options.opencodexHome;
  if (!opencodexHome) return { status: "unknown-home" };
  const authPath = join(opencodexHome, "auth.json");
  let store = {};
  if (await exists(authPath)) {
    try {
      store = JSON.parse(await readFile(authPath, "utf8"));
    } catch {
      // A store we cannot parse is one we must not rewrite: the operator's other logins live there.
      return { status: "unreadable-store", nextStep: `${setup.command} login anthropic` };
    }
  }
  // An existing login always wins. Overwriting it would replace a refreshable credential the
  // operator chose with one that cannot refresh.
  if (store.anthropic) return { status: "existing-login-preserved" };
  const found = await (options.readToken ?? readClaudeSetupToken)({ env: options.env, now: options.now });
  if (!found) return { status: "no-local-token", nextStep: `${setup.command} login anthropic` };
  if (options.dryRun) return { status: "planned", source: found.source };
  const now = (options.now ?? Date.now)();
  const accountId = (options.accountId ?? (() => randomUUID().replace(/-/g, "")))();
  store.anthropic = {
    activeAccountId: accountId,
    accounts: [{
      id: accountId,
      credential: {
        access: found.token,
        refresh: "",
        expires: Math.round(found.issuedAt + SETUP_TOKEN_LIFETIME_MS),
        accountId,
        source: "oauth",
      },
      addedAt: now,
    }],
  };
  await mkdir(dirname(authPath), { recursive: true });
  const staged = `${authPath}.next-${randomUUID()}`;
  await writeFile(staged, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(staged, 0o600);
  await rename(staged, authPath);
  return {
    status: "imported",
    source: found.source,
    expires: store.anthropic.accounts[0].credential.expires,
    note: "setup-tokens carry no refresh half; ocx status reports them as 'stale credentials' while they work",
  };
}
