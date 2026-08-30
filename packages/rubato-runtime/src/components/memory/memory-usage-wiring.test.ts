import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { readMemoryUsageLedger, memoryUsagePaths } from "./memory-usage-ledger"
import { registerMemoryUsage } from "./memory-usage-wiring"
import { eventContext, fixture, toolCall } from "./memory-usage.test-support"

describe("registerMemoryUsage", () => {
  test("#given a read tool targeting reference/project/foo.md #when dispatched then flushed #then foo.md.count is 1", async () => {
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "reference", "project", "foo.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(ledger["reference/project/foo.md"]).toEqual({ count: 1, lastUsedAt: "2026-01-15T10:00:00.000Z" })
  })

  // Exclusion follows projection, not the `system/` prefix. A projected file is already in
  // the prompt so reading it proves nothing; an unprojected one had to be opened on purpose,
  // and dream demotes `system/` files that never appear in this ledger.
  test("#given a read of a PROJECTED system file #when dispatched then flushed #then it earns no credit", async () => {
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      resolveProjected: () => new Set(["system/persona.md"]),
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "system", "persona.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given a read of an UNPROJECTED system file #when dispatched then flushed #then it earns credit", async () => {
    // The regression this guards: with an empty whitelist every system/ read was dropped,
    // so the file most in demand looked permanently unused to dream.
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      resolveProjected: () => new Set(),
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "system", "persona.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(ledger["system/persona.md"]?.count).toBe(1)
  })

  test("#given no resolveProjected wiring #when a system file is read #then it still earns credit", async () => {
    // Absent means "nothing projected", matching the whitelist's own default.
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, "system", "human.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(ledger["system/human.md"]?.count).toBe(1)
  })

  test("#given a read tool targeting .tmp/scratch.md #when dispatched then flushed #then ledger is empty (.tmp excluded)", async () => {
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: join(repoDir, ".tmp", "scratch.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given a write tool targeting reference/project/foo.md #when dispatched then flushed #then ledger is empty (only read tools tracked)", async () => {
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("write", { path: join(repoDir, "reference", "project", "foo.md") }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })

  test("#given a read tool targeting a path outside the repo #when dispatched then flushed #then ledger is empty", async () => {
    const { context, repoDir } = await fixture()
    const pi = new FakeExtensionAPI()
    const trackers = registerMemoryUsage(pi, {
      resolveContext: () => context,
      resolveCwd: () => repoDir,
      now: () => new Date("2026-01-15T10:00:00Z"),
    })
    await pi.dispatch(
      "tool_call",
      toolCall("read", { path: "/tmp/some-other-file.md" }),
      eventContext("session-1"),
    )
    const tracker = trackers.get(context.identity)
    await tracker?.flush()
    const ledger = await readMemoryUsageLedger(memoryUsagePaths(context.identityPaths).ledgerPath)
    expect(Object.keys(ledger)).toEqual([])
  })
})
