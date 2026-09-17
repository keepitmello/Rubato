import { describe, expect, test } from "bun:test"

import {
  formatSpeedIndexLabel,
  rememberTaskSpeedRatio,
  scoreTaskSpeedIndex,
  taskSpeedRatio,
} from "./task-speed-index"

describe("taskSpeedIndex", () => {
  test("#given a 64k cached call at the bundled median #when scored #then Speed is 100", () => {
    expect(taskSpeedRatio(8658.089124999999, 80_000, 0.75)).toBeCloseTo(1, 5)
    expect(scoreTaskSpeedIndex([1])).toBe(100)
    expect(formatSpeedIndexLabel(100)).toBe("Speed 100")
  })

  test("#given twice the reference duration #when scored #then Speed is 50", () => {
    const ratio = taskSpeedRatio(8658.089124999999 * 2, 80_000, 0.75)
    expect(scoreTaskSpeedIndex([ratio ?? 0])).toBe(50)
  })

  test("#given an unmatched input band #when scored #then no Speed is emitted", () => {
    expect(taskSpeedRatio(1000, 300, 0.8)).toBeUndefined()
    expect(scoreTaskSpeedIndex([])).toBeUndefined()
    expect(formatSpeedIndexLabel(undefined)).toBeUndefined()
  })

  test("#given more than 200 ratios #when remembered #then only the latest cap is kept", () => {
    let ratios: number[] = []
    for (let i = 0; i < 205; i += 1) ratios = rememberTaskSpeedRatio(ratios, 1)
    expect(ratios).toHaveLength(200)
  })
})
