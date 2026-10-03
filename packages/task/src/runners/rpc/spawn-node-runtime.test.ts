import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "bun:test"

test("#given stock pi exposes rpc-entry only to import #when building a fallback spawn #then it uses the physical bundle entry", async () => {
  const sourceDir = dirname(import.meta.path)
  const bundleDir = mkdtempSync(join(sourceDir, ".spawn-node-runtime-"))

  try {
    const build = await Bun.build({
      entrypoints: [join(sourceDir, "spawn.ts")],
      outdir: bundleDir,
      target: "node",
      format: "esm",
    })
    expect(build.success).toBe(true)

    const output = build.outputs[0]
    if (output === undefined) throw new TypeError("spawn bundle output is missing")

    const script = `
      import { buildRpcModelCatalogSpawn, buildRpcSpawn } from ${JSON.stringify(pathToFileURL(output.path).href)}
      const spec = {
        task_id: "st_node_runtime",
        cwd: process.cwd(),
        state_dir: "/tmp/st_node_runtime",
        prompt: "READY",
      }
      const runtime = {
        isBunBinary: false,
        execPath: process.execPath,
        platform: process.platform,
        parentEnv: { PATH: "" },
        resolveSenpiExecutable: () => null,
      }
      console.log(JSON.stringify([buildRpcSpawn(spec, runtime).args[0], buildRpcModelCatalogSpawn(spec, runtime).args[0]]))
    `
    const child = spawnSync("node", ["--input-type=module", "--eval", script], {
      cwd: sourceDir,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    })

    expect(`${child.status}\n${child.stderr}`).toBe("0\n")
    const [rpcEntry, catalogCli] = JSON.parse(child.stdout.trim()) as [string, string]
    expect(rpcEntry).toEndWith(join("@earendil-works", "pi-coding-agent", "dist", "bundle", "rpc-entry.js"))
    expect(existsSync(rpcEntry)).toBe(true)
    expect(catalogCli).toBe(join(dirname(rpcEntry), "cli.js"))
    expect(existsSync(catalogCli)).toBe(true)
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
})
