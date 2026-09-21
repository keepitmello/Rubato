import { afterEach, describe, expect, test } from "bun:test"

import { resolveCategory } from "../category"
import { baseSpec, cleanupProjects, makeManager } from "./__fixtures__/manager-fakes"

afterEach(() => {
  cleanupProjects()
})

describe("TaskManager runtime fallback visibility", () => {
  test("#given a running category child #when Senpi applies a fallback #then the task record exposes the actual model", async () => {
    // given
    const { manager, store, inProcess } = makeManager({
      planner: () => ({
        kind: "resolved",
        plan: {
          model: "kimi-coding/kimi-for-coding-highspeed-unlocked",
          resolved_model: {
            source: "model",
            provider: "kimi-coding",
            model_id: "kimi-for-coding-highspeed-unlocked",
            display: "kimi-coding/kimi-for-coding-highspeed-unlocked",
            reasoning_effort: "minimal",
          },
        },
      }),
    })
    const started = await manager.start(baseSpec())
    if (started.kind !== "started") throw new Error(`Unexpected start result: ${started.kind}`)
    const fake = inProcess.handles.get(started.task_id)
    if (fake === undefined) throw new Error("Fake child handle missing")
    const fallbackEvent = {
      type: "retry_fallback_applied",
      from: "kimi-coding/kimi-for-coding-highspeed-unlocked",
      to: "quotio-openai/gpt-5.6-luna-fast:minimal",
      chainKey: "kimi-coding/kimi-for-coding-highspeed-unlocked",
      reason: "hard-error",
    }

    // when
    fake.emit(fallbackEvent)

    // then
    expect(store.load(started.task_id)).toMatchObject({
      model: "quotio-openai/gpt-5.6-luna-fast",
      resolved_model: {
        source: "model",
        provider: "quotio-openai",
        model_id: "gpt-5.6-luna-fast",
        display: "quotio-openai/gpt-5.6-luna-fast",
        reasoning_effort: "minimal",
      },
    })
    fake.settle({ status: "completed", finalResponse: "done" })
    await manager.waitFor(started.task_id)
  })
})
