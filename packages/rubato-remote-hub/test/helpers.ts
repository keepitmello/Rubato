import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LiveSessionSummary } from "@rubato/remote-protocol"

export const HOST_ID = "018f1e2d-3c4b-7a6f-8abc-1234567890ab"
export const SESSION_ID = "018f1e2d-3c4b-7b6f-8abc-1234567890ab"
export const SESSION_2_ID = "018f1e2d-3c4b-7c6f-8abc-1234567890ab"

export function summary(overrides: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    schemaVersion: 1,
    hostId: HOST_ID,
    liveSessionId: SESSION_ID,
    zmxName: "rubato-018f1e2d3c4b",
    managed: true,
    pid: 123,
    lifecycle: "ready",
    execution: "idle",
    attention: false,
    title: "Test",
    cwd: "/tmp",
    createdAt: "2026-08-31T00:00:00.000Z",
    pi: {},
    model: { label: "Test" },
    context: {},
    cache: { expired: true },
    background: { activeCount: 0, labels: [] },
    teams: { activeRunCount: 0, runningMemberCount: 0, failedMemberCount: 0 },
    build: { piVersion: "0.84.2", remoteProtocolMin: 1, remoteProtocolMax: 1 },
    capabilities: [],
    ...overrides,
  }
}

export async function temporaryDirectory(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "rubato-hub-test-"))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
