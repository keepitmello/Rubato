import { access, copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";

export const LOCAL_AGY_AGENT = "RUBATO_LOCAL_AGY_AGENT";
export const LOCAL_AGY_ISOLATED = "RUBATO_LOCAL_AGY_ISOLATED";
export const LOCAL_AGY_APPROVAL_BRIDGE = "RUBATO_LOCAL_AGY_APPROVAL_BRIDGE";

export function localAgyApprovalSpawn<T extends {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}>(spawn: T, environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined): T {
  const bridge = environment?.find(entry => entry.name === LOCAL_AGY_APPROVAL_BRIDGE)?.value;
  if (!bridge || !path.isAbsolute(bridge)) return spawn;
  return { ...spawn, command: process.execPath, args: [bridge, spawn.command, ...spawn.args],
    env: { ...spawn.env, ELECTRON_RUN_AS_NODE: "1" } };
}

export function localAgyAgent(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
) {
  return environment?.find((entry) => entry.name === LOCAL_AGY_AGENT)?.value.trim() || undefined;
}

export function localAgyIsolated(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
) {
  const raw = environment?.find((entry) => entry.name === LOCAL_AGY_ISOLATED)?.value.trim().toLowerCase();
  return raw === "1" || raw === "true";
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
