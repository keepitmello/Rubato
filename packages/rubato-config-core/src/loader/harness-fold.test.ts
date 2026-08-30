import { describe, expect, test } from "bun:test"

import { resolveRubatoConfigView } from "../index"

describe("resolveRubatoConfigView codegraph harness folding", () => {
  test("#given overlapping base and codex excluded roots #when folding the codex block #then roots retain their ordered unique union", () => {
    // given
    const config = {
      codegraph: {
        excluded_roots: ["/tmp/rubato-base", "/tmp/rubato-shared"],
      },
      "[codex]": {
        codegraph: {
          excluded_roots: ["/tmp/rubato-shared", "/tmp/rubato-codex"],
        },
      },
    }

    // when
    const result = resolveRubatoConfigView({ config, harness: "codex" })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config).toEqual({
      codegraph: {
        excluded_roots: ["/tmp/rubato-base", "/tmp/rubato-shared", "/tmp/rubato-codex"],
      },
    })
  })
})
