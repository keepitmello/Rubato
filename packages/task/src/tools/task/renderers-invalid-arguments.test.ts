import { describe, expect, test } from "bun:test"

import type { ThemeColor } from "@code-yeongyu/senpi"

import { renderTaskResultComponent, statusThemeColor } from "./renderers"

const OBSERVED_REASON = "Exactly one of model or preset is required."

const RECORDING_THEME = {
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  italic: (text: string) => text,
}

describe("invalid task arguments", () => {
  test("#given invalid_arguments #when mapped #then the status uses the error theme", () => {
    // when
    const color = statusThemeColor("invalid_arguments")

    // then
    expect(color).toBe("error")
  })

  test("#given the observed malformed task result #when rendered #then it is visibly classified as an error with its reason", () => {
    // given
    const details = {
      agentId: "",
      status: "invalid_arguments",
      mode: "spawn" as const,
      reason: OBSERVED_REASON,
    }

    // when
    const rendered = renderTaskResultComponent(details, RECORDING_THEME).render(120).join("\n")

    // then
    expect(rendered).toStartWith("<error>")
    expect(rendered).toContain("invalid_arguments")
    expect(rendered).toContain("reason:Exactly one of model or preset is req")
  })
})
