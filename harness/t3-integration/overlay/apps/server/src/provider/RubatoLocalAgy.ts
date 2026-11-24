// @effect-diagnostics nodeBuiltinImport:off -- the agy home is prepared with plain file calls before the CLI starts.
import { access, copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { AGY_NATIVE_DIR_ENV, agyNativeDir } from "./RubatoAgyNative.ts";

export const LOCAL_AGY_AGENT = "RUBATO_LOCAL_AGY_AGENT";
export const LOCAL_AGY_ISOLATED = "RUBATO_LOCAL_AGY_ISOLATED";
/** On an isolated instance: the instance whose Google login (profile) it runs on, instead of its own. */
export const LOCAL_AGY_LOGIN = "RUBATO_LOCAL_AGY_LOGIN";
export const LOCAL_AGY_APPROVAL_BRIDGE = "RUBATO_LOCAL_AGY_APPROVAL_BRIDGE";

/** A provider instance's environment: a value is a string or a reference to a stored secret. */
type InstanceEnvironment = ReadonlyArray<{ readonly name: string; readonly value: unknown }> | undefined;

/** The named plain value, trimmed; a secret reference or a missing entry is none. */
function plainValue(environment: InstanceEnvironment, name: string): string | undefined {
  const value = environment?.find((entry) => entry.name === name)?.value;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function localAgyApprovalSpawn<T extends {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}>(spawn: T, environment: InstanceEnvironment): T {
  const bridge = plainValue(environment, LOCAL_AGY_APPROVAL_BRIDGE);
  if (!bridge || !path.isAbsolute(bridge)) return spawn;
  // The bridge also lands the GUI's rewinds and forks on agy's own store (RubatoAgyNative.ts).
  return { ...spawn, command: process.execPath, args: [bridge, spawn.command, ...spawn.args],
    env: { ...spawn.env, ELECTRON_RUN_AS_NODE: "1", [AGY_NATIVE_DIR_ENV]: agyNativeDir() } };
}

export function localAgyAgent(environment: InstanceEnvironment) {
  return plainValue(environment, LOCAL_AGY_AGENT);
}

export function localAgyIsolated(environment: InstanceEnvironment) {
  const raw = plainValue(environment, LOCAL_AGY_ISOLATED)?.toLowerCase();
  return raw === "1" || raw === "true";
}

/** The instance whose isolated login this one shares, or undefined for its own login. */
export function localAgyLoginOwner(environment: InstanceEnvironment) {
  return plainValue(environment, LOCAL_AGY_LOGIN);
}

export function localAgySpawn(
  binary: string,
  agent: string,
  cwd: string,
  home: string,
  environment: NodeJS.ProcessEnv,
) {
  // Start real agy with its normal home and login, without handing it secrets,
  // provider endpoint overrides, or another agent's environment.
  // Windows keeps the profile and temp folders in its own variables, and Path in any case.
  const env = { HOME: home } as Record<string, string>;
  const wanted = new Set([
    "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "PATHEXT", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA",
  ]);
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && wanted.has(key.toUpperCase()) && key.toUpperCase() !== "HOME") env[key] = value;
  }
  env.RUBATO_AGY_WORKSPACE = cwd;
  return {
    command: binary,
    args: ["acp", "--sandbox", "--agent", agent],
    cwd,
    env,
    shell: false as const,
    extendEnv: false as const,
  };
}

export function localAgyWithAgentArgs<Spawn extends {
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}>(
  spawn: Spawn,
  agent: string,
): Spawn {
  return {
    ...spawn,
    args: [...spawn.args, "--sandbox", "--agent", agent],
    ...(spawn.cwd ? { env: { ...spawn.env, RUBATO_AGY_WORKSPACE: spawn.cwd } } : {}),
  };
}

/**
 * Link the user's `~/.gemini/config/agents` and `mcp_config.json` into an isolated
 * Antigravity profile so extra Google accounts share the Rubato lead agent and MCP tools.
 * (Skills are already linked by upstream `linkAntigravityUserConfig`.)
 */
export async function linkLocalAgyProfileConfig(
  profileDirectory: string,
  userHome: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const userConfig = path.join(userHome, ".gemini", "config");
  const profileConfig = path.join(profileDirectory, "config");
  await mkdir(profileConfig, { recursive: true });

  const linkOrSkip = async (name: string, kind: "dir" | "file") => {
    const target = path.join(userConfig, name);
    try { await access(target); } catch { return; }
    const dest = path.join(profileConfig, name);
    if (platform === "win32" && kind === "file") {
      try { await copyFile(target, dest); } catch { /* best-effort */ }
      return;
    }
    let existing = null;
    try { existing = await lstat(dest); } catch { /* absent */ }
    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        const current = path.resolve(profileConfig, await readlink(dest));
        if (current === path.resolve(target)) return;
        await rm(dest, { force: true });
      } else {
        return;
      }
    }
    const symlinkType = kind === "dir" ? (platform === "win32" ? "junction" : "dir") : "file";
    await symlink(target, dest, symlinkType);
  };

  try { await linkOrSkip("agents", "dir"); } catch { /* best-effort */ }
  try { await linkOrSkip("mcp_config.json", "file"); } catch { /* best-effort */ }
}

export function localAgyModels<Model extends { readonly slug: string; readonly name: string }>(
  models: ReadonlyArray<Model>,
  _agentLabel?: string,
): ReadonlyArray<Model> {
  return models.filter((model) => /^gemini-(?:[4-9]|[1-9]\d+)(?:[.-]|$)/i.test(model.slug));
}

// `agy agents` prints one agent per line; agy silently falls back to its default for an unknown name.
export function hasLocalAgyAgent(listing: string, agent: string) {
  return listing.split(/\r?\n/).some((line) => line.trim() === agent);
}
