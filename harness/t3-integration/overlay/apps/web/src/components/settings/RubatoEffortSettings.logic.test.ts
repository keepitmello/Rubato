import { describe, expect, it } from "@effect/vitest";

import { modelEffortView, nearestLevel, offeredLevels } from "./RubatoEffortSettings.logic";

const SONNET = ["low", "medium", "high"];

describe("nearestLevel", () => {
  it("keeps an offered level, else takes the next one up, else the next one down", () => {
    expect(nearestLevel("medium", SONNET)).toBe("medium");
    expect(nearestLevel("minimal", SONNET)).toBe("low");
    expect(nearestLevel("max", SONNET)).toBe("high");
    expect(nearestLevel("high", [])).toBeNull();
  });
});

describe("modelEffortView", () => {
  const settings = { defaultLevel: "xhigh" as const, models: { "anthropic/claude-haiku-5-5": "low" as const } };

  it("shows a following model at the level it will really start at", () => {
    expect(modelEffortView("anthropic/claude-sonnet-5-5", SONNET, settings)).toEqual({ own: null, followed: "high" });
  });

  it("shows a model's own level apart from the one it would follow", () => {
    expect(modelEffortView("anthropic/claude-haiku-5-5", SONNET, settings)).toEqual({ own: "low", followed: "high" });
  });

  it("knows no level before the settings are read or with no level for every model", () => {
    expect(modelEffortView("anthropic/claude-sonnet-5-5", SONNET, null)).toEqual({ own: null, followed: null });
    expect(modelEffortView("anthropic/claude-sonnet-5-5", SONNET, { defaultLevel: null, models: {} })).toEqual({
      own: null,
      followed: null,
    });
  });
});

describe("offeredLevels", () => {
  it("reads the reasoning levels the catalogue gave the model", () => {
    const capabilities = {
      optionDescriptors: [
        { id: "reasoningEffort", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] },
        { id: "fastMode", type: "boolean" },
      ],
    };
    expect(offeredLevels(capabilities).map((option) => option.id)).toEqual(["low", "high"]);
    expect(offeredLevels(null)).toEqual([]);
  });
});
