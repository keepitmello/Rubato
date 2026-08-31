import { describe, expect, test } from "bun:test"

import {
  RubatoTaskSettingsLayerSchema,
  RubatoTaskSettingsSchema,
  resolveRubatoTaskSettings,
  type RubatoTaskSettings,
} from "./task"

// 0 is the unbounded sentinel for the concurrency/residency caps: the engine already maps it to
// Infinity (TaskConcurrency.getLimit) and to "admit every child" (residency admission), so the
// schema must let it through unchanged rather than clamping or rejecting it.
describe("RubatoTaskSettingsSchema zero-as-unlimited concurrency", () => {
  test("#given global concurrency values #when task settings parse #then zero, one, and eight are accepted", () => {
    expect(RubatoTaskSettingsSchema.parse({ global_concurrency: 0 }).global_concurrency).toBe(0)
    expect(RubatoTaskSettingsSchema.parse({ global_concurrency: 1 }).global_concurrency).toBe(1)
    expect(RubatoTaskSettingsSchema.parse({ global_concurrency: 8 }).global_concurrency).toBe(8)
  })

  test("#given invalid global concurrency values #when task settings parse #then they are rejected", () => {
    for (const value of [-1, 1.5, "x"]) {
      expect(RubatoTaskSettingsSchema.safeParse({ global_concurrency: value }).success).toBe(false)
    }
  })

  test("#given no global concurrency layer override #when layer parses #then no default is injected", () => {
    expect(RubatoTaskSettingsLayerSchema.parse({})).not.toHaveProperty("global_concurrency")
  })

  test("#given generated schema #when global concurrency values validate #then zero and four pass and negative one fails", () => {
    expect(RubatoTaskSettingsSchema.safeParse({ global_concurrency: 0 }).success).toBe(true)
    expect(RubatoTaskSettingsSchema.safeParse({ global_concurrency: 4 }).success).toBe(true)
    expect(RubatoTaskSettingsSchema.safeParse({ global_concurrency: -1 }).success).toBe(false)
  })

  test("#given zero concurrency caps #when task settings parse #then zero is preserved as the unbounded sentinel", () => {
    // given
    const input = {
      default_concurrency: 0,
      provider_concurrency: { anthropic: 0 },
      model_concurrency: { "anthropic/opus": 0 },
      residency_max_children: 0,
    }

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.default_concurrency).toBe(0)
    expect(parsed.provider_concurrency?.anthropic).toBe(0)
    expect(parsed.model_concurrency?.["anthropic/opus"]).toBe(0)
    expect(parsed.residency_max_children).toBe(0)
  })

  test("#given zero concurrency caps #when the layer schema parses #then zero survives layer merging", () => {
    // given
    const input = {
      default_concurrency: 0,
      provider_concurrency: { anthropic: 0 },
      model_concurrency: { "anthropic/opus": 0 },
      residency_max_children: 0,
    }

    // when
    const parsed = RubatoTaskSettingsLayerSchema.parse(input)

    // then
    expect(parsed.default_concurrency).toBe(0)
    expect(parsed.provider_concurrency?.anthropic).toBe(0)
    expect(parsed.model_concurrency?.["anthropic/opus"]).toBe(0)
    expect(parsed.residency_max_children).toBe(0)
  })

  test("#given an explicit zero residency cap #when settings resolve #then the parallelism default never overrides it", () => {
    // given
    const input = { residency_max_children: 0 }

    // when
    const parsed = resolveRubatoTaskSettings(input, () => 16)

    // then
    expect(parsed.residency_max_children).toBe(0)
  })

  test("#given \"unlimited\" on a concurrency field #when task settings parse #then only numbers are accepted", () => {
    // given
    const input = { default_concurrency: "unlimited" }

    // when
    const result = RubatoTaskSettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected a string concurrency to fail")
    expect(result.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("default_concurrency")
  })

  test("#given negative or fractional concurrency caps #when task settings parse #then each field is rejected", () => {
    // given
    const inputs = [
      { default_concurrency: -1 },
      { default_concurrency: 1.5 },
      { provider_concurrency: { anthropic: -1 } },
      { provider_concurrency: { anthropic: 1.5 } },
      { model_concurrency: { "anthropic/opus": -1 } },
      { model_concurrency: { "anthropic/opus": 1.5 } },
      { residency_max_children: -1 },
      { residency_max_children: 1.5 },
    ]

    // when
    const results = inputs.map((input) => ({
      settings: RubatoTaskSettingsSchema.safeParse(input).success,
      layer: RubatoTaskSettingsLayerSchema.safeParse(input).success,
    }))

    // then
    expect(results).toEqual(inputs.map(() => ({ settings: false, layer: false })))
  })
})

describe("RubatoTaskSettingsSchema warnings", () => {
  test("#given no warning suppression override #when task settings parse #then unavailable categories warnings default on", () => {
    // given
    const input = {}

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.warnings?.unavailable_categories).toBe(true)
  })

  test("#given an explicit warning suppression override #when task settings parse #then the false override is preserved", () => {
    // given
    const input = { warnings: { unavailable_categories: false } }

    // when
    const parsed = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.warnings?.unavailable_categories).toBe(false)
  })

  test("#given a non-boolean warning suppression override #when task settings parse #then validation fails at the nested path", () => {
    // given
    const input = { warnings: { unavailable_categories: "nope" } }

    // when
    const result = RubatoTaskSettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected task settings parsing to fail")
    expect(result.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("warnings.unavailable_categories")
  })
})

describe("RubatoTaskSettingsSchema reattach", () => {
  test(" w2reattach #given no reconcile override #when task settings parse #then reattach remains enabled by absence", () => {
    // given
    const input = {}

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.reattach_on_reconcile).toBeUndefined()
  })

  test(" w2reattach #given reattach is disabled #when task settings parse #then the false override is preserved", () => {
    // given
    const input = { reattach_on_reconcile: false }

    // when
    const parsed = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.reattach_on_reconcile).toBe(false)
  })
})

describe("RubatoTaskSettingsSchema resume_children", () => {
  test("#given no resume_children key #when task settings parse #then resume_children defaults to true", () => {
    // given
    const input = {}

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.resume_children).toBe(true)
  })

  test("#given resume_children explicitly false #when task settings parse #then the false override is preserved", () => {
    // given
    const input = { resume_children: false }

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.resume_children).toBe(false)
  })

  test("#given resume_children explicitly true #when task settings parse #then true is preserved", () => {
    // given
    const input = { resume_children: true }

    // when
    const parsed: RubatoTaskSettings = RubatoTaskSettingsSchema.parse(input)

    // then
    expect(parsed.resume_children).toBe(true)
  })

  test("#given resume_children with non-boolean value #when task settings parse #then validation fails", () => {
    // given
    const input = { resume_children: "yes" }

    // when
    const result = RubatoTaskSettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected parsing to fail")
    expect(result.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("resume_children")
  })
})
