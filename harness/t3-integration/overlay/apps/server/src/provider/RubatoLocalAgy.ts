export const LOCAL_AGY_AGENT = "RUBATO_LOCAL_AGY_AGENT";

export function localAgyAgent(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
) {
  return environment?.find((entry) => entry.name === LOCAL_AGY_AGENT)?.value.trim() || undefined;
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
  return {
    command: binary,
    args: ["acp", "--sandbox", "--agent", agent],
    cwd,
    env,
    shell: false as const,
    extendEnv: false as const,
  };
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
