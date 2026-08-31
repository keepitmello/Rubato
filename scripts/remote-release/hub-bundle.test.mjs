import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { once } from "node:events"
import test from "node:test"

import { buildHubBundle } from "./build-release.mjs"

test("release hub ESM bundle loads CommonJS web-push dependencies", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "rubato-hub-bundle-"))
  t.after(() => rm(output, { recursive: true, force: true }))
  const repository = resolve(import.meta.dirname, "..", "..")

  await buildHubBundle({ repository, output })

  const main = join(output, "hub", "main.mjs")
  assert.match(await readFile(main, "utf8"), /createRequire/)
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, HOME: output, RUBATO_HOST_DISPLAY_NAME: "Bundle Test", RUBATO_OWNER_LOGIN: "bundle@example.com" },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const earlyExit = once(child, "exit").then(([code, signal]) => ({ code, signal }))
  const result = await Promise.race([
    earlyExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
  ])
  assert.equal(result, null, `hub exited during startup: ${JSON.stringify(result)} ${stderr}`)
  child.kill("SIGTERM")
  await earlyExit
})

test("release includes a standalone protocol runtime for the Pi extension", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "rubato-protocol-bundle-"))
  t.after(() => rm(output, { recursive: true, force: true }))
  const repository = resolve(import.meta.dirname, "..", "..")
  const esbuild = join(repository, "packages", "rubato-remote-hub", "node_modules", ".bin", "esbuild")
  await new Promise((resolveRun, reject) => {
    const child = spawn(esbuild, [
      join(repository, "packages", "rubato-remote-protocol", "src", "index.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node24",
      `--outfile=${join(output, "index.mjs")}`,
    ])
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`protocol bundle exited ${code}`)))
    child.once("error", reject)
  })
  const protocol = await import(`${pathToFileURL(join(output, "index.mjs")).href}?test=${Date.now()}`)
  assert.equal(protocol.REMOTE_PROTOCOL_NAME, "rubato.remote.v1")
  assert.equal(protocol.surfaceToHubFrameSchema.parse({
    kind: "surface.heartbeat",
    protocol: "rubato.remote.v1",
    surfaceInstanceId: "018f1e2d-3c4b-7b6f-8abc-1234567890ab",
    sourceSeq: 1,
    at: new Date().toISOString(),
  }).kind, "surface.heartbeat")
})
