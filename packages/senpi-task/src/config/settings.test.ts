import { availableParallelism } from "node:os"
import { describe, expect, test } from "bun:test"

import { resolveRubatoTaskSettings } from "@rubato/config-core"

describe("task settings", () => {
  test("#given no residency override #when settings parse #then defaults residency cap to max of eight and cpu times three", () => {
    // given
    const expected = Math.max(8, availableParallelism() * 3)

    // when
    const settings = resolveRubatoTaskSettings({})
    const twoCpuSettings = resolveRubatoTaskSettings({}, () => 2)
    const fourCpuSettings = resolveRubatoTaskSettings({}, () => 4)

    // then
    expect(settings.residency_max_children).toBe(expected)
    expect(twoCpuSettings.residency_max_children).toBe(8)
    expect(fourCpuSettings.residency_max_children).toBe(12)
    expect(twoCpuSettings.global_concurrency).toBe(8)
    expect(resolveRubatoTaskSettings({}, () => 6).global_concurrency).toBe(12)
    expect(resolveRubatoTaskSettings({ global_concurrency: 3 }, () => 6).global_concurrency).toBe(3)
  })
})
