#!/usr/bin/env node
// Restarts the remote hub. The profile engine runs it (harness/pi-server/src/hub-supervisor.mjs);
// writing its spec again with a new request time is what makes the engine restart it. With no
// engine running, this starts the engine, which then starts the hub.
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"

import { defaultPaths } from "../../scripts/remote-release/constants.mjs"
import { pathExists, readJson, run } from "../../scripts/remote-release/lib.mjs"
import { activateHub, canonicalHubEntryPath, writeHubService } from "../../scripts/remote-release/system.mjs"
import { ensureProfileEngine } from "../pi-server/src/discovery.mjs"
import { resolveLaunchAgentDir } from "../rubato-pi/src/launch.mjs"

export async function restartRemoteHub({
  paths = defaultPaths(),
  runner = run,
  bunPath = process.env.RUBATO_BUN_BIN || join(homedir(), ".bun", "bin", "bun"),
  tailscalePath = process.env.RUBATO_TAILSCALE_PATH || "/usr/local/bin/tailscale",
  launcherPath = join(fileURLToPath(new URL(".", import.meta.url)), "rubato-pi.sh"),
  ensureEngine = () => ensureProfileEngine({ descriptorPath: join(resolveLaunchAgentDir(), "server", "connection.json") }),
  timeouts = {},
} = {}) {
  const entryPath = canonicalHubEntryPath(paths)
  if (!await pathExists(entryPath)) throw new Error("release hub entry is missing: " + entryPath)
  const release = await readJson(join(paths.current, "release.json"))
  if (!release?.buildId) throw new Error("release metadata is invalid")
  await writeHubService(paths, release.buildId, bunPath, launcherPath, tailscalePath)
  const activated = await activateHub(paths, { runner, ensureEngine, ...timeouts })
  return { buildId: release.buildId, entryPath, supervisedBy: activated.supervisedBy, ...(activated.pid ? { pid: activated.pid } : {}) }
}

async function main() {
  const result = await restartRemoteHub()
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n")
}

function isCli() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isCli()) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n")
    process.exit(1)
  })
}
