/**
 * Maintainer rollout: updates launch the existing uploader outside the engine.
 * A private-repository write check in the child is the enrollment boundary.
 * This starter neither authenticates nor claims the child uploaded anything.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpeedIndexAgentDir } from "./speed-index-store.mjs";
import { SPEED_DATA_DISABLED_FILE } from "./speed-data-export.mjs";

export const MAINTAINER_SPEED_DATA_REPO = "keepitmello/rubato-speed-data";
const uploader = fileURLToPath(new URL("../scripts/sync-speed-data.mjs", import.meta.url));

export function startSpeedDataUpload({
  env = process.env, node = process.execPath, runner = spawn,
  home = env.HOME || env.USERPROFILE || homedir(),
  agentDir = resolveSpeedIndexAgentDir(env, home) ?? join(home, ".rubato-pi", "agent"),
} = {}) {
  if (env.NODE_TEST_CONTEXT) return { status: "skipped", reason: "test" };
  if (env.RUBATO_SPEED_DATA_UPLOAD === "0") return { status: "skipped", reason: "disabled" };
  const root = join(agentDir, "speed-index");
  const samples = join(root, "samples");
  if (existsSync(join(root, SPEED_DATA_DISABLED_FILE))) return { status: "skipped", reason: "disabled" };
  if (!existsSync(samples)) return { status: "skipped", reason: "no_samples" };
  const log = join(root, "github-sync.log");
  let fd;
  try {
    fd = openSync(log, "a", 0o600);
    const child = runner(node, [uploader, "--repo", MAINTAINER_SPEED_DATA_REPO,
      "--samples", samples, "--state", join(root, "github-sync.json"), "--upload"], {
      detached: true,
      windowsHide: true,
      cwd: dirname(uploader),
      // Never turn an uploader's own imports into Speed capture or network probes.
      env: { ...env, HOME: home, USERPROFILE: home, RUBATO_SPEED_INDEX: "0", RUBATO_SPEED_INDEX_PROBE: "0" },
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (error) => {
      try { appendFileSync(log, `Speed data auto: child did not start (${error.code ?? "spawn_error"})\n`); } catch {}
    });
    child.unref();
    return child.pid ? { status: "started", log } : { status: "skipped", reason: "spawn_failed", log };
  } catch {
    return { status: "skipped", reason: "start_failed", log };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
