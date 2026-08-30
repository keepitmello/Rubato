import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import type { FactsPayload, ReflectionWorktree, ReservedRun } from "@rubato/memory-core"

import { rmEfaultTolerant } from "../teardown.test-support"
import {
  MEMORY_CHILD_EXTENSIONS_ENV,
  memoryChildExtensionArgs,
  memoryChildExtensionPaths,
} from "./child-extensions"
import { prepareFactsSpawn, prepareReflectionForkSpawn, prepareReflectionSpawn } from "./spawn"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  ))
})

async function root(): Promise<string> {
  const path = realpathSync.native(await mkdtemp(join(tmpdir(), "rubato-memory-child-ext-")))
  roots.push(path)
  return path
}

const OVERLAY = "/opt/rubato/extensions/broker-overlay.mjs"
const SECOND = "/opt/rubato/extensions/other-provider.mjs"

const run: ReservedRun = {
  runId: "run-1",
  request: { trigger: "manual", conversationIds: [], snapshots: [] },
}

const payload: FactsPayload = {
  version: 1,
  identity: "agent-test",
  today: "2026-08-10",
  entries: [],
  knownPeople: [],
  primaryHuman: { slug: "human", aliases: [] },
}

function reflectionInput(base: string, env: NodeJS.ProcessEnv) {
  return {
    run,
    worktree: {
      dir: base,
      commonConfigPath: join(base, "config"),
    } as unknown as ReflectionWorktree,
    reflectionSessionsDir: join(base, "sessions"),
    category: "quick",
    model: "provider/model",
    env,
    mergePolicy: "auto" as const,
    skillsUsageSource: join(base, "skills.json"),
    memoryUsageSource: join(base, "memory-usage.json"),
    dreamStateSource: join(base, "dream.json"),
    peoplePolicy: { enabled: true, max_entries: 40, max_entry_chars: 200 },
    senpiCommand: "/custom/senpi",
  }
}

/** The `-e <path>` pair immediately following the flag, so ordering regressions are caught. */
function extensionEntries(args: readonly string[]): readonly string[] {
  const found: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-e" || args[i] === "--extension") {
      const value = args[i + 1]
      if (value !== undefined) found.push(value)
    }
  }
  return found
}

describe("memoryChildExtensionPaths", () => {
  test("#given no host extension list #when parsed #then the child argv gains nothing", () => {
    expect(memoryChildExtensionPaths({})).toEqual([])
    expect(memoryChildExtensionArgs({})).toEqual([])
  })

  test("#given a delimited list with blanks and duplicates #when parsed #then entries are trimmed unique and ordered", () => {
    const env = {
      [MEMORY_CHILD_EXTENSIONS_ENV]: ["", ` ${OVERLAY} `, SECOND, OVERLAY, "  "].join(delimiter),
    }

    expect(memoryChildExtensionPaths(env)).toEqual([OVERLAY, SECOND])
    expect(memoryChildExtensionArgs(env)).toEqual(["-e", OVERLAY, "-e", SECOND])
  })
})

describe("memory child provider extensions", () => {
  test("#given a host provider extension #when a reflection spawn is prepared #then the child loads it despite --no-extensions", async () => {
    const prepared = await prepareReflectionSpawn(
      reflectionInput(await root(), { [MEMORY_CHILD_EXTENSIONS_ENV]: OVERLAY }),
    )

    expect(prepared.args).toContain("--no-extensions")
    expect(extensionEntries(prepared.args)).toEqual([OVERLAY])
    // The isolation flags must survive: the extension entry buys providers, not a full boot.
    expect(prepared.args).toContain("--no-skills")
    expect(prepared.args).toContain("--no-context-files")
  })

  test("#given a host provider extension #when a facts spawn is prepared #then the child loads it", async () => {
    const prepared = await prepareFactsSpawn({
      runId: "facts-1",
      runDir: await root(),
      payload,
      model: "provider/model",
      env: { [MEMORY_CHILD_EXTENSIONS_ENV]: OVERLAY },
      senpiCommand: "/custom/senpi",
    })

    expect(prepared.args).toContain("--no-extensions")
    expect(extensionEntries(prepared.args)).toEqual([OVERLAY])
  })

  test("#given a host provider extension #when a fork spawn is prepared #then it loads before --fork and no isolation flag is reintroduced", async () => {
    const base = await root()
    const prepared = await prepareReflectionForkSpawn({
      ...reflectionInput(base, { [MEMORY_CHILD_EXTENSIONS_ENV]: OVERLAY }),
      parentSessionFile: join(base, "parent.jsonl"),
    })

    expect(extensionEntries(prepared.args)).toEqual([OVERLAY])
    expect(prepared.args.indexOf("-e")).toBeLessThan(prepared.args.indexOf("--fork"))
    // Fork mode reuses the parent's request prefix; -e must not drag the prefix-breaking flags in.
    for (const flag of ["--system-prompt", "--tools", "--no-extensions", "--no-skills", "--no-context-files"]) {
      expect(prepared.args).not.toContain(flag)
    }
  })

  test("#given no host extension list #when spawns are prepared #then the argv is unchanged from the discovery-disabled shape", async () => {
    const prepared = await prepareReflectionSpawn(reflectionInput(await root(), {}))

    expect(extensionEntries(prepared.args)).toEqual([])
  })
})
