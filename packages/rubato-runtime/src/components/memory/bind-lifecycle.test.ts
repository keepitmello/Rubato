import { expect, test } from "bun:test"
import { buildIdentityPaths } from "@rubato/memory-core"
import { createMemoryIdentityContext } from "./context"
import type { MemoryIdentityRuntime } from "./identity-runtime"
import { MemoryFakeExtensionAPI, loadedMemoryConfig, memorySettings } from "./memory.test-support"
import { createMemoryWiring } from "./wiring"

test("shutdown invalidates a delayed bind before it touches the stale session or starts later phases", async () => {
  const identity = createMemoryIdentityContext({
    identity: "bind-lifecycle-fixture", identityPaths: buildIdentityPaths("/unused-fixture", "bind-lifecycle-fixture"),
    binding: { identity: "bind-lifecycle-fixture", repoPathHash: "fixture", boundAt: 1 },
  })
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const wiring = createMemoryWiring({
    sessions: new Map([["session-a", { context: identity }]]), cwd: () => "/unused-fixture", env: {},
    loadConfig: () => loadedMemoryConfig(memorySettings()),
    createRuntime: () => ({ reconcile: () => pending }) as unknown as MemoryIdentityRuntime,
  })
  let reads = 0
  const bind = wiring.afterBind(new MemoryFakeExtensionAPI(), "session-a", identity, {
    sessionManager: { getEntries: () => { reads++; throw new Error("stale session"); } },
  })
  // No shutdown mutation starts: this is a deliberately exhausted drain budget.
  await wiring.onSessionShutdown({ sessionId: "session-a", reason: "reload", deadlineAt: 0, now: () => 0 })
  finish()
  await bind
  expect(reads).toBe(0)
})
