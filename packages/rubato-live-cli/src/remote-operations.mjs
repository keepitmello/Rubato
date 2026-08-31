import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function createRemoteOperations({ env = process.env, script, spawnProcess = spawn } = {}) {
  return {
    doctor: (args = []) => invoke("doctor", args, { allowFailure: true }),
    guardUpdate: (args = []) => invoke("guard-update", args),
    update: (args) => invoke("update", args),
    uninstall: (args) => invoke("uninstall", args),
  };

  async function invoke(command, args, options = {}) {
    const entrypoint = script ?? await releaseScript(env);
    const child = spawnProcess(process.execPath, [entrypoint, command, ...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (value) => stdout.push(value));
    child.stderr.on("data", (value) => stderr.push(value));
    const code = await new Promise((fulfill, reject) => {
      child.once("error", reject);
      child.once("close", fulfill);
    });
    const output = Buffer.concat(stdout).toString("utf8").trim();
    let result;
    try { result = JSON.parse(output); }
    catch { throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `remote ${command} returned invalid output`); }
    if (code !== 0 && !options.allowFailure) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `remote ${command} failed`);
    return { result, exitCode: code ?? 1 };
  }
}

async function releaseScript(env) {
  const candidates = [
    env.RUBATO_REMOTE_RELEASE_SCRIPT,
    resolve(import.meta.dirname, "../../remote-release/remote-release.mjs"),
    resolve(import.meta.dirname, "../../../scripts/remote-release/remote-release.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("Rubato Remote release operations are not installed");
}
