import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CreateAgentSessionOptions, ToolDefinition } from "@code-yeongyu/senpi"
import { RubatoTaskSettingsSchema } from "@rubato/config-core"
import {
  InProcessRunner,
  type ChildSession,
  type ChildSessionListener,
  type ChildSpec,
} from "@rubato/senpi-task"

// The stock child factory is untyped ESM; the test only needs the runtime guard.
// @ts-expect-error -- no declaration file for the .mjs factory
import { createStockChildInProcessSession } from "../../../../../harness/pi-runtime/features/child-runtime/stock-rpc-runtime.mjs"
import {
  createStockInProcessSessionAdapter,
  createTaskRunnerFactories,
  DEFAULT_RUNNER_FACTORIES,
  TASK_CHILD_UI_ONLY_TOOL_NAMES,
} from "./engine-runners"
import { TaskRuntimeContext } from "./runtime-context"

// The adapter keeps the main Senpi entry type-only, so the stub tools below carry a local schema
// instead of borrowing one from a runtime Senpi export.
const sampleParameters: ToolDefinition["parameters"] = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: sampleParameters,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
  }
}

function createFakeSession(sessionId = "child-session-1"): { readonly session: ChildSession; resolvePrompt: () => void } {
  const listeners = new Set<ChildSessionListener>()
  let settle: { resolve: () => void } | undefined
  const session: ChildSession = {
    sessionId,
    prompt() {
      return new Promise<void>((resolve) => {
        settle = { resolve }
      })
    },
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe(listener: ChildSessionListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLastAssistantText: () => undefined,
    dispose: () => Promise.resolve(),
  }
  return { session, resolvePrompt: () => settle?.resolve() }
}

function baseSpec(overrides: Partial<ChildSpec> = {}): ChildSpec {
  const sessionDir = mkdtempSync(join(tmpdir(), "rubato-runtime-engine-runners-"))
  tempDirs.push(sessionDir)
  return {
    taskId: "task-1",
    cwd: process.cwd(),
    sessionDir,
    depth: 0,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    prompt: "do the work",
    ...overrides,
  }
}

describe("task child memory tool exclusion", () => {
  test("#given the ui-only tool names passed to the in-process runner #when inspected #then both memory tools are listed", () => {
    // given / when / then
    expect(TASK_CHILD_UI_ONLY_TOOL_NAMES).toContain("memory")
    expect(TASK_CHILD_UI_ONLY_TOOL_NAMES).toContain("memory_apply_patch")
  })

  test("#given shared parent tools including memory tools #when an in-process child starts #then the child tool set excludes them", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const fake = createFakeSession()
    const runner = new InProcessRunner({
      sharedParentTools: [makeTool("grep"), makeTool("memory"), makeTool("memory_apply_patch")],
      uiOnlyToolNames: TASK_CHILD_UI_ONLY_TOOL_NAMES,
      createSession: async (options) => {
        captured = options
        return fake.session
      },
    })

    // when
    const handle = await runner.start(baseSpec())
    fake.resolvePrompt()
    await handle.waitForIdle()

    // then
    const names = (captured?.customTools ?? []).map((tool) => tool.name)
    expect(names).toEqual(["grep"])
    expect(names).not.toContain("memory")
    expect(names).not.toContain("memory_apply_patch")
  })

  test("#given the default runner factories #when the in-process runner is built #then construction succeeds with the ui-only names wired", () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), "rubato-runtime-engine-runners-factory-"))
    tempDirs.push(cwd)

    // when
    const runner = DEFAULT_RUNNER_FACTORIES.inProcess({
      runtime: new TaskRuntimeContext(cwd),
      sharedParentTools: () => [],
      settings: RubatoTaskSettingsSchema.parse({}),
    })

    // then
    expect(typeof runner.start).toBe("function")
  })
})

describe("stock in-process session adapter agentDir", () => {
  class FakeResourceLoader {
    readonly options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
    }
    async reload() {}
    getExtensions() {
      return { errors: [] }
    }
  }

  test("#given a stockChildProfile agentDir and child options that omit it #when the managed runner starts #then the inner session factory receives that agentDir", async () => {
    let captured: CreateAgentSessionOptions | undefined
    const fake = createFakeSession()
    const factories = createTaskRunnerFactories({
      stockChildProfile: { agentDir: "/explicit/parent-agent" },
      createInProcessSession: async (options) => {
        captured = options
        return fake.session
      },
    })
    const cwd = mkdtempSync(join(tmpdir(), "rubato-runtime-engine-runners-agentdir-"))
    tempDirs.push(cwd)
    const runner = factories.inProcess({
      runtime: new TaskRuntimeContext(cwd),
      sharedParentTools: () => [],
      settings: RubatoTaskSettingsSchema.parse({}),
    })

    const handle = await runner.start({
      taskId: "task-1",
      cwd,
      stateDir: join(cwd, ".rubato", "task"),
      prompt: "do the work",
      depth: 0,
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
    })
    expect(captured?.agentDir).toBe("/explicit/parent-agent")
    fake.resolvePrompt()
    await handle.waitForOutcome()
  })

  test("#given options that omit agentDir #when the adapter wraps the stock child factory #then a child session is created instead of the agentDir throw", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "rubato-runtime-stock-child-agent-"))
    tempDirs.push(agentDir)
    const adapted = createStockInProcessSessionAdapter(
      async (options) =>
        createStockChildInProcessSession(options, {
          createAgentSession: async () => ({
            session: {
              bindExtensions: async () => {},
            },
          }),
          DefaultResourceLoader: FakeResourceLoader,
        }),
      undefined,
      undefined,
      agentDir,
    )

    const session = await adapted({
      cwd: agentDir,
      settingsManager: { ok: true },
    } as unknown as CreateAgentSessionOptions)

    expect(typeof (session as { bindExtensions?: unknown }).bindExtensions).toBe("function")
  })
})
