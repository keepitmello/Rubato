import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMemoryComponent } from "./index"
import { componentContext, loadedMemoryConfig, memorySettings, MemoryFakeExtensionAPI } from "./memory.test-support"
import { MSEARCH_CLI_ENV, createMemorySearchTool, type MsearchRun } from "./search-tool"
import { MEMORY_SEARCH_TOOL_NAME } from "./tool-metadata"

type Call = { file: string; args: readonly string[]; cwd: string }

function recorder(outcome: MsearchRun = { stdout: "[rubato/repo/decisions/a.md]\nbody", stderr: "", error: null }) {
  const calls: Call[] = []
  const run = async (file: string, args: readonly string[], cwd: string) => {
    calls.push({ file, args, cwd })
    return outcome
  }
  return { calls, run }
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("")
}

describe("memory_search", () => {
  test("#given no scope #then it searches the current project and the user, with the query after --", async () => {
    const { calls, run } = recorder()
    const tool = createMemorySearchTool({ cwd: "/work/project" }, { env: {}, run })
    const result = await tool.execute("c1", { query: "  -tool surface diet " })
    expect(calls).toEqual([{ file: "msearch", args: ["--", "-tool surface diet"], cwd: "/work/project" }])
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain("[rubato/repo/decisions/a.md]")
  })

  test("#given scope user or all #then it passes -u or -a", async () => {
    const { calls, run } = recorder()
    const tool = createMemorySearchTool({}, { env: {}, run, resolveCwd: () => "/fallback" })
    await tool.execute("c1", { query: "q", scope: "user" })
    await tool.execute("c2", { query: "q", scope: "all" })
    expect(calls.map((call) => call.args)).toEqual([["-u", "--", "q"], ["-a", "--", "q"]])
    expect(calls.every((call) => call.cwd === "/fallback")).toBe(true)
  })

  test("#given the launcher published the CLI path #then that wrapper runs", async () => {
    const { calls, run } = recorder()
    const tool = createMemorySearchTool({ cwd: "/p" }, { env: { [MSEARCH_CLI_ENV]: "/opt/rubato/harness/msearch/msearch" }, run })
    await tool.execute("c1", { query: "q" })
    expect(calls[0]?.file).toBe("/opt/rubato/harness/msearch/msearch")
  })

  test("#given msearch fails #then the result is an error that keeps its output and points to --doctor", async () => {
    const { run } = recorder({ stdout: "", stderr: "msearch: 검색 백엔드에 연결하지 못했습니다.", error: "Command failed: exit 1" })
    const result = await createMemorySearchTool({ cwd: "/p" }, { env: {}, run }).execute("c1", { query: "q" })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("검색 백엔드에 연결하지 못했습니다")
    expect(text(result)).toContain("msearch --doctor")
  })

  test("#given an empty query #then nothing runs", async () => {
    const { calls, run } = recorder()
    const result = await createMemorySearchTool({ cwd: "/p" }, { env: {}, run }).execute("c1", { query: "   " })
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("#given the memory component registers #then memory_search is visible from the first request while writes stay behind search", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rubato-memory-search-"))
    mkdirSync(cwd, { recursive: true })
    const pi = new MemoryFakeExtensionAPI()
    createMemoryComponent({
      env: { RUBATO_MEMORY_HOME: join(cwd, "memory") },
      loadConfig: () => loadedMemoryConfig(memorySettings()),
      resolveCwd: () => cwd,
      dreamLauncher: { launch: () => false },
    }).register(pi, componentContext())
    const byName = new Map(pi.tools.map((tool) => [tool.name, tool]))
    expect(byName.get(MEMORY_SEARCH_TOOL_NAME)?.exposure).toBe("direct")
    expect(byName.get("memory")?.exposure).toBeUndefined()
    expect(byName.get("memory_apply_patch")?.exposure).toBeUndefined()
  })
})
