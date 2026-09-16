import { describe, expect, test } from "bun:test"

import { SenpiTeamSpecError } from "./errors"
import { type SenpiTeamMemberPorts, validateSenpiTeamMembers } from "./member-validator"
import { normalizeSenpiTeamSpec } from "./normalize"

const MODEL = "rubato-mock/mock-1"
const allowModel: SenpiTeamMemberPorts = {
  isModelAvailable: (model) => model === MODEL,
  modelNames: [MODEL],
}

describe("validateSenpiTeamMembers", () => {
  test("#given a live model #when validated #then it passes", () => {
    const spec = normalizeSenpiTeamSpec(
      { members: [{ kind: "owner", model: MODEL, prompt: "Work on the assigned slice." }] },
      "model-team",
    )

    expect(() => validateSenpiTeamMembers(spec, allowModel)).not.toThrow()
  })

  test("#given an unavailable model #when validated #then the live catalog is listed", () => {
    const spec = normalizeSenpiTeamSpec(
      { members: [{ kind: "owner", model: "missing/model", prompt: "Work on the assigned slice." }] },
      "missing-model-team",
    )

    expect(() => validateSenpiTeamMembers(spec, allowModel)).toThrow(
      new SenpiTeamSpecError(
        `Team 'missing-model-team' member 'model-1' references unavailable model 'missing/model'. Available models: ${MODEL}.`,
        "MODEL_UNAVAILABLE",
        "missing-model-team",
      ),
    )
  })
})
