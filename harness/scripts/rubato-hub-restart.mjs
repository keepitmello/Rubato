#!/usr/bin/env node
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { defaultPaths } from "../../scripts/remote-release/constants.mjs"
import { pathExists, readJson, run } from "../../scripts/remote-release/lib.mjs"
import {
  canonicalHubEntryPath,
  installLaunchAgent,
  launchAgentNeedsRepair,
  waitForHealth,
} from "../../scripts/remote-release/system.mjs"

export async function repairRemoteHubLaunchAgent({
  paths = defaultPaths(),
  force = true,
  runner = run,
  bunPath = process.env.RUBATO_BUN_BIN || join(homedir(), ".bun", "bin", "bun"),
  tailscalePath = process.env.RUBATO_TAILSCALE_PATH || "/usr/local/bin/tailscale",
  launcherPath = join(fileURLToPath(new URL(".", import.meta.url)), "rubato-pi.sh"),
} = {}) {
  const entryPath = canonicalHubEntryPath(paths)
  if (!await pathExists(entryPath)) throw new Error("release hub entry is missing: " + entryPath)
  const release = await readJson(join(paths.current, "release.json"))
  if (!release?.buildId) throw new Error("release metadata is invalid")
  const plist = await readFile(paths.plist, "utf8").catch(() => "")
  if (!force && !launchAgentNeedsRepair(plist, { entryPath })) {
    const domain = "gui/" + process.getuid()
    await runner("/bin/launchctl", ["kickstart", "-k", domain + "/com.keepitmello.rubato.remote-hub"], { check: false })
    return { repaired: false, buildId: release.buildId, entryPath }
  }
  await installLaunchAgent(paths, release.buildId, runner, bunPath, launcherPath, tailscalePath)
  return { repaired: true, buildId: release.buildId, entryPath }
}

async function main() {
  const result = await repairRemoteHubLaunchAgent({ force: true })
  const paths = defaultPaths()
  const host = await readJson(paths.host)
  await waitForHealth(host.httpPort, { attempts: 80, delayMs: 500 })
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
