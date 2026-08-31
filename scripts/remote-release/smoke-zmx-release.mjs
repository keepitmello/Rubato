#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { readJson, run, sha256 } from "./lib.mjs"
import { terminalBridgeSmoke, zmxSmoke } from "./system.mjs"

export async function smokeZmxRelease(options) {
  const repository = resolve(options.repository ?? join(import.meta.dirname, "..", ".."))
  const directory = resolve(options.directory)
  const runner = options.runner ?? run
  const manifest = await readJson(join(directory, "zmx-release-manifest.json"))
  const runtime = join(directory, ".smoke-runtime")
  await rm(runtime, { recursive: true, force: true })
  await mkdir(join(runtime, "current", "hub"), { recursive: true })
  const esbuild = join(repository, "packages", "rubato-remote-hub", "node_modules", ".bin", "esbuild")
  await runner(esbuild, [join(repository, "packages", "rubato-terminal-bridge", "src", "bun-helper.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node24", `--outfile=${join(runtime, "current", "hub", "bun-helper.ts")}`])
  const results = []
  try {
    for (const entry of manifest.assets) {
      const asset = join(directory, entry.file)
      if (await sha256(asset) !== entry.sha256) throw new Error(`${entry.platform} checksum differs from the one-time build manifest`)
      await zmxSmoke(asset, runner)
      const terminal = await terminalBridgeSmoke({ current: join(runtime, "current"), zmx: asset }, options.bun ?? "bun", runner)
      results.push({ platform: entry.platform, runListKill: "pass", terminalAttachFrameEcho: "pass", frameBytes: terminal.bytes, leakedSessions: 0 })
    }
  } finally { await rm(runtime, { recursive: true, force: true }) }
  const report = { schemaVersion: 1, sourceCommit: manifest.source.commit, assets: results }
  await writeFile(join(directory, "zmx-smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const directory = process.argv[2]
  if (!directory) { console.error("usage: smoke-zmx-release.mjs <zmx-release-directory>"); process.exit(2) }
  smokeZmxRelease({ directory }).then((report) => console.log(JSON.stringify(report))).catch((error) => { console.error(`smoke-zmx-release: ${error.message}`); process.exitCode = 1 })
}
