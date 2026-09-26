import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rmSyncEfaultTolerant } from "../components/memory/teardown.test-support"

import { GitMemoryRepo, buildIdentityPaths, parseMemoryFile } from "@rubato/memory-core"

import { MEMORY_UNBOUND_MESSAGE } from "../components/memory/tool-metadata"
import { handleMemoryMcpRequest } from "./memory-server"

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rubato-memory-mcp-"))
  roots.push(root)
  const paths = buildIdentityPaths(join(root, "memory-home"), "proj")
  return { root, paths, provenance: { sessionId: "session-1", identityId: "proj", repoPath: paths.repo } }
}

afterEach(() => {
  // Windows keeps git's handles open briefly after the child exits, so a bare recursive remove
  // throws EBUSY and fails the test that already passed. Retry the unlink instead.
  for (const root of roots.splice(0)) rmSyncEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// Each case drives real git subprocesses through a fresh repository; the 5s default is not a
// budget these operations fit on a loaded Windows runner.
setDefaultTimeout(process.platform === "win32" ? 30_000 : 5_000)

function call(id: number, name: string, args: Record<string, unknown>) {
  return handleMemoryMcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
}

describe("rubato-memory MCP server", () => {
  test("#given initialize #then server info and tool capabilities are returned", async () => {
    const result = await handleMemoryMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const payload = result?.result as { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } | undefined
    expect(payload?.serverInfo?.name).toBe("rubato-memory")
    expect(payload?.capabilities?.tools).toBeDefined()
  })

  test("#given tools/list #then exactly the two memory tools are exposed", async () => {
    const result = await handleMemoryMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (result?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(["memory", "memory_apply_patch"])
  })

  test("#given the session's bound store #when create then str_replace run #then that store records them with the session trailer", async () => {
    const { paths, provenance } = fixture()
    const created = await call(3, "memory", {
      command: "create", reason: "Record why", file_path: "decisions/cache-key.md",
      description: "Cache key", file_text: "- prompt hash", provenance,
    })
    expect((created?.result as { isError?: boolean } | undefined)?.isError).toBeFalsy()
    const replaced = await call(4, "memory", {
      command: "str_replace", reason: "Model joins the key", file_path: "decisions/cache-key.md",
      old_string: "- prompt hash", new_string: "- prompt hash plus model", provenance,
    })
    expect((replaced?.result as { isError?: boolean } | undefined)?.isError).toBeFalsy()

    const file = parseMemoryFile(readFileSync(join(paths.repo, "decisions/cache-key.md"), "utf8"))
    expect(file.body.trim()).toBe("- prompt hash plus model")
    const log = await new GitMemoryRepo({ dir: paths.repo, agentId: "proj" }).log({ limit: 2 })
    expect(log.map((entry) => entry.subject)).toEqual(["Model joins the key", "Record why"])
    expect(log[0]?.trailers["Rubato-Session"]).toBe("session-1")
  })

  test("#given no bound store #when a memory call arrives #then it says memory is off and creates nothing", async () => {
    const { root } = fixture()
    const result = await call(5, "memory_apply_patch", { reason: "r", input: "*** Begin Patch\n*** End Patch" })
    const payload = result?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined
    expect(payload?.isError).toBe(true)
    expect(payload?.content?.[0]?.text).toContain(MEMORY_UNBOUND_MESSAGE)
    expect(existsSync(join(root, "memory-home"))).toBe(false)
  })
})
