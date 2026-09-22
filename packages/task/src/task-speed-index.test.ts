import { describe, expect, test } from "bun:test"
import { formatSpeedIndexLabel, readTaskSpeedIndex } from "./task-speed-index"

describe("provider-owned Speed snapshot", () => {
  test("uses the observed score unchanged for either metric version", () => {
    for (const metricVersion of [1, 2]) {
      expect(readTaskSpeedIndex({
        rubatoSpeedIndex: { version: 1, metricVersion, status: "ready", score: 147 },
      })).toBe(147)
    }
    expect(formatSpeedIndexLabel(147)).toBe("Speed 147")
  })

  test("an explicit no-score snapshot reads as a dash, not as a missing value", () => {
    expect(readTaskSpeedIndex({
      rubatoSpeedIndex: { version: 1, metricVersion: 2, status: "unavailable", score: null },
    })).toBeNull()
    expect(readTaskSpeedIndex({
      rubatoSpeedIndex: { version: 1, metricVersion: 1, status: "unavailable", score: null },
    })).toBeNull()
  })

  test("missing, future and malformed snapshots never recreate a score", () => {
    expect(readTaskSpeedIndex({})).toBeUndefined()
    const good = { version: 1, metricVersion: 2, status: "ready", score: 100 }
    for (const override of [
      { version: 2 }, { metricVersion: 99 }, { status: "future-status" },
      { score: null }, { score: -1 }, { score: Infinity }, { score: 1.1 }, { score: "100" },
    ]) {
      expect(readTaskSpeedIndex({ rubatoSpeedIndex: { ...good, ...override } })).toBeUndefined()
    }
    expect(formatSpeedIndexLabel(undefined)).toBeUndefined()
  })
})
