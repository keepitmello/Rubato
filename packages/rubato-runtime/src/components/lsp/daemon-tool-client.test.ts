import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "bun:test"
import { callPackagedDaemonTool, clearPackagedDaemonToolClientCache } from "./daemon-tool-client"

test("daemon requests carry separate cwd and config paths through the actual client adapter", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rubato-lsp-context-")))
  const originalCwd = process.cwd()
  const runtime = join(root, "runtime/lsp-daemon/dist")
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ version: "fixture", type: "module" }))
  writeFileSync(join(runtime, "cli.js"), "// Not executed\n")
  writeFileSync(join(runtime, "client.js"), "export async function callToolViaDaemon(name,args,options){return {content:[],details:{name,context:options.context}}}\n")
  const importer = pathToFileURL(join(root, "adapter/index.js")).href
  try {
    const [a, b] = await Promise.all(["a", "b"].map(async name => {
      const cwd = join(root, name)
      mkdirSync(cwd)
      return callPackagedDaemonTool("lsp_symbols", {}, { cwd }, importer)
    }))
    expect(a?.details).toMatchObject({ name: "symbols", context: { cwd: join(root, "a"), projectConfigPaths: [join(root, "a/.pi/lsp-client.json")] } })
    expect(b?.details).toMatchObject({ name: "symbols", context: { cwd: join(root, "b"), projectConfigPaths: [join(root, "b/.pi/lsp-client.json")] } })
    expect(process.cwd()).toBe(originalCwd)
  } finally {
    clearPackagedDaemonToolClientCache()
    rmSync(root, { recursive: true, force: true })
  }
})
