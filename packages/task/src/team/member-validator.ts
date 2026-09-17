import type { TeamSpec } from "@rubato/team-core/types"

import { SenpiTeamSpecError } from "./errors"

/** Team members use the same live model registry as the Agent tool. */
export type SenpiTeamMemberPorts = {
  readonly isModelAvailable: (model: string) => boolean
  readonly modelNames?: readonly string[]
}

/** Validates parsed team members against the live host model catalog. */
export function validateSenpiTeamMembers(spec: TeamSpec, ports: SenpiTeamMemberPorts): void {
  for (const member of spec.members) {
    if (!ports.isModelAvailable(member.model)) {
      const available = ports.modelNames !== undefined && ports.modelNames.length > 0
        ? ` Available models: ${[...ports.modelNames].sort().join(", ")}.`
        : ""
      throw new SenpiTeamSpecError(
        `Team '${spec.name}' member '${member.name}' references unavailable model '${member.model}'.${available}`,
        "MODEL_UNAVAILABLE",
        spec.name,
      )
    }
  }
}
