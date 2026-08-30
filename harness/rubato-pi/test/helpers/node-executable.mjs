import { spawnSync } from "node:child_process";

// bun test sets process.execPath to bun. These suites spawn node:test children
// that must be a real Node binary, resolved from PATH rather than a host path.
export function resolveNodeExecutable() {
  if (process.versions.bun === undefined) return process.execPath;
  const probe = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const bin = probe.stdout.trim();
  if (probe.status === 0 && bin.length > 0) return bin;
  throw new Error(`failed to resolve node executable: ${probe.stderr || probe.error?.message || "not found"}`);
}

export function nodeChildEnv(overrides = {}) {
  const env = { ...process.env, ...overrides, NODE_OPTIONS: "" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST")) delete env[key];
  }
  return env;
}
