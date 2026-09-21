import { describe, expect, test } from "bun:test"

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CreateAgentSessionOptions } from "@code-yeongyu/senpi"

import { resolveCategory } from "../category"
import { InProcessRunner } from "./in-process"
import type { ChildSession, ChildSpec } from "./in-process"

function completedSession(): ChildSession {
  return {
    sessionId: "runtime-fallback-child",
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe: () => () => {},
    getLastAssistantText: () => "done",
    dispose: () => {},
  }
}

function baseSpec(): ChildSpec {
  return {
    taskId: "task-runtime-fallback",
    cwd: process.cwd(),
    sessionDir: mkdtempSync(join(tmpdir(), "senpi-task-runtime-fallback-")),
    depth: 0,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    prompt: "do the work",
  }
}

function capturedRetrySettings(options: CreateAgentSessionOptions | undefined): unknown {
  if (options === undefined) return undefined
  const settingsManager = Reflect.get(options, "settingsManager")
  if (typeof settingsManager !== "object" || settingsManager === null) return undefined
  const getRetryFallbackSettings = Reflect.get(settingsManager, "getRetryFallbackSettings")
  return typeof getRetryFallbackSettings === "function"
    ? Reflect.apply(getRetryFallbackSettings, settingsManager, [])
    : undefined
}

describe("InProcessRunner runtime fallback", () => {
  test("#given a selected model and ordered fallbacks #when the child session is created #then child-local runtime fallback settings preserve the chain", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const runner = new InProcessRunner({
      createSession: async (options) => {
        captured = options
        return completedSession()
      },
    })
    const fallbackModels = [
      {
        source: "model" as const,
        provider: "quotio-openai",
        model_id: "gpt-5.6-luna-fast",
        display: "quotio-openai/gpt-5.6-luna-fast",
        reasoning_effort: "minimal",
      },
      {
        source: "model" as const,
        provider: "example-gateway",
        model_id: "z-ai/glm-5.2-ultrafast-unlocked",
        display: "example-gateway/z-ai/glm-5.2-ultrafast-unlocked",
        reasoning_effort: "none",
      },
    ] as const
    const spec = {
      ...baseSpec(),
      selectedModel: "kimi-coding/kimi-for-coding-highspeed-unlocked",
      fallbackModels,
    }

    // when
    const handle = await runner.start(spec)
    await handle.waitForIdle()

    // then
    expect(capturedRetrySettings(captured)).toMatchObject({
      modelFallback: true,
      chains: {
        "kimi-coding/kimi-for-coding-highspeed-unlocked": [
          "quotio-openai/gpt-5.6-luna-fast:minimal",
          "example-gateway/z-ai/glm-5.2-ultrafast-unlocked:none",
        ],
      },
    })
  })

  test("#given runtime fallback models with both reasoning effort and variant #when the child session is created #then reasoning effort wins over variant", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const runner = new InProcessRunner({
      createSession: async (options) => {
        captured = options
        return completedSession()
      },
    })
    const spec = {
      ...baseSpec(),
      selectedModel: "kimi-coding/kimi-for-coding-highspeed-unlocked",
      fallbackModels: [
        {
          source: "model" as const,
          provider: "quotio-openai",
          model_id: "gpt-5.6-luna-fast",
          display: "quotio-openai/gpt-5.6-luna-fast",
          reasoning_effort: "high",
          variant: "max",
        },
      ],
    }

    // when
    const handle = await runner.start(spec)
    await handle.waitForIdle()

    // then
    expect(capturedRetrySettings(captured)).toMatchObject({
      chains: {
        "kimi-coding/kimi-for-coding-highspeed-unlocked": ["quotio-openai/gpt-5.6-luna-fast:high"],
      },
    })
  })

  test("#given no runtime fallbacks #when the child session is created #then global model fallback is disabled", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const runner = new InProcessRunner({
      createSession: async (options) => {
        captured = options
        return completedSession()
      },
    })

    // when
    const handle = await runner.start(baseSpec())
    await handle.waitForIdle()

    // then
    expect(capturedRetrySettings(captured)).toMatchObject({
      modelFallback: false,
      chains: {},
    })
  })
})
