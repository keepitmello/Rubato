import { execFile } from "node:child_process"

import { Type, type Static } from "typebox"

import type { SenpiExtensionAPI } from "../../extension/types"
import { MEMORY_SEARCH_DESCRIPTION, MEMORY_SEARCH_TOOL_NAME } from "./tool-metadata"
import type { MemoryToolExecutionResult } from "./tools"

// memory_search runs the msearch CLI (harness/msearch). The CLI stays the engine because other CLIs
// (Claude Code, grok, cursor) call it too; this tool exists so a Rubato session sees memory search
// next to its other tools instead of grepping ~/.rubato/memory by hand. It is exposed from the first
// request: sessions that grepped the store never reached tool_search, and the prompt line naming
// msearch did not stop them (rubato memory decisions/tool-surface-diet.md).

/** The launcher publishes the CLI path here (harness/rubato-pi/src/launch.mjs); otherwise PATH. */
export const MSEARCH_CLI_ENV = "RUBATO_MSEARCH_CLI"
const SEARCH_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export const MemorySearchParams = Type.Object({
  query: Type.String({ description: "What to find, in English with short anchors (a component, an error, a decision). The user's own words and raw errors also match." }),
  scope: Type.Optional(Type.Union([
    Type.Literal("project"),
    Type.Literal("user"),
    Type.Literal("all"),
  ], { description: "project (default): this project's memory and the shared memory about the user. user: only the memory about the user. all: every project's memory; results that suggest -a mean this." })),
})

export type MemorySearchInput = Static<typeof MemorySearchParams>

export interface MsearchRun {
  readonly stdout: string
  readonly stderr: string
  /** null when the process ran and exited 0. */
  readonly error: string | null
}

export type MsearchRunner = (file: string, args: readonly string[], cwd: string) => Promise<MsearchRun>

export interface MemorySearchToolOptions {
  readonly env?: Record<string, string | undefined>
  readonly resolveCwd?: () => string
  readonly run?: MsearchRunner
}

export function msearchArgs(params: MemorySearchInput): string[] {
  const flag = params.scope === "user" ? ["-u"] : params.scope === "all" ? ["-a"] : []
  // `--` keeps a query that starts with a dash from reading as a flag.
  return [...flag, "--", params.query]
}

export function msearchCli(env: Record<string, string | undefined>): string {
  const published = env[MSEARCH_CLI_ENV]?.trim()
  return published ? published : "msearch"
}

const runMsearch: MsearchRunner = (file, args, cwd) => new Promise((resolve) => {
  execFile(file, [...args], { cwd, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({ stdout, stderr, error: error === null ? null : error.message })
  })
})

export function createMemorySearchTool(pi: Pick<SenpiExtensionAPI, "cwd">, options: MemorySearchToolOptions = {}) {
  const env = options.env ?? process.env
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const run = options.run ?? runMsearch
  return {
    name: MEMORY_SEARCH_TOOL_NAME,
    label: "Memory Search",
    description: MEMORY_SEARCH_DESCRIPTION,
    parameters: MemorySearchParams,
    exposure: "direct" as const,
    execute: async (_toolCallId: string, params: MemorySearchInput): Promise<MemoryToolExecutionResult> => {
      const query = params.query.trim()
      if (query === "") return result(`${MEMORY_SEARCH_TOOL_NAME}: query is empty`, true)
      const cli = msearchCli(env)
      const outcome = await run(cli, msearchArgs({ ...params, query }), pi.cwd ?? resolveCwd())
      const output = [outcome.stdout.trim(), outcome.stderr.trim()].filter((part) => part !== "").join("\n")
      if (outcome.error === null) return result(output === "" ? "NO RELEVANT MEMORY" : output, false)
      const hint = `Run \`${cli} --doctor\` in bash to see what is missing.`
      return result([`${MEMORY_SEARCH_TOOL_NAME}: msearch failed: ${outcome.error}`, output, hint].filter((part) => part !== "").join("\n"), true)
    },
  }
}

function result(message: string, isError: boolean): MemoryToolExecutionResult {
  return { content: [{ type: "text", text: message }], details: { message }, ...(isError ? { isError } : {}) }
}

export function registerMemorySearchTool(pi: SenpiExtensionAPI, options: MemorySearchToolOptions = {}): void {
  pi.registerTool({ ...createMemorySearchTool(pi, options) })
}
