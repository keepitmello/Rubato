import { describe, expect, test } from "bun:test"
import { Value } from "typebox/value"
import { TeamMemberReplacementError } from "../../team"
import { createFakeTeamService, fakeCreatedMember } from "./__fixtures__/team-tool-fakes"
import { createTeamReplaceMemberTool, runTeamReplaceMember, TeamReplaceMemberParams } from "./replacement"

const input = {
  team_run_id: "00000000-0000-4000-8000-000000000000",
  member: "beta", expected_task_id: "st_old", model: "rubato-mock/mock-1",
  prompt: "Recheck evidence.md revision B. The earlier PASS covers revision A only.",
}

describe("team_replace_member tool", () => {
  test("maps the explicit recovery request without allowing a lead or role override", async () => {
    const service = createFakeTeamService({
      replaceMember: async () => ({
        teamRunId: input.team_run_id, previousTaskId: input.expected_task_id,
        member: fakeCreatedMember({ name: "beta", taskId: "st_new", role: { kind: "verifier", model: input.model } }),
      }),
    })
    const result = await runTeamReplaceMember(service, { ...input, effort: "high", task_summary: "Recheck B" })
    expect(service.calls).toEqual([{
      method: "replaceMember",
      args: [{
        teamRunId: input.team_run_id, member: "beta", expectedTaskId: "st_old", model: input.model,
        prompt: input.prompt, effort: "high", taskSummary: "Recheck B",
      }],
    }])
    expect(result.details).toMatchObject({ kind: "replaced", previous_task_id: "st_old", member: { task_id: "st_new" } })
    expect(JSON.stringify(result.content)).toContain("not a completed verification")
    expect(TeamReplaceMemberParams.properties).not.toHaveProperty("lead_session_id")
    expect(TeamReplaceMemberParams.properties).not.toHaveProperty("kind")
  })

  test("requires a handoff and exposes the current exact model catalog", () => {
    let models = ["rubato-mock/mock-1"]
    const tool = createTeamReplaceMemberTool({
      service: createFakeTeamService(), models: { has: (model) => models.includes(model), list: () => models },
    })
    expect(Value.Check(tool.parameters, input)).toBe(true)
    expect(Value.Check(tool.parameters, { ...input, prompt: "" })).toBe(false)
    expect(Value.Check(tool.parameters, { ...input, model: "missing/model" })).toBe(false)
    expect(Value.Check(tool.parameters, { ...input, kind: "owner" })).toBe(false)
    models = ["other/model"]
    expect(Value.Check(tool.parameters, input)).toBe(false)
    expect(Value.Check(tool.parameters, { ...input, model: "other/model" })).toBe(true)
    expect(tool.description).toContain("user approval")
  })

  test("reports rejected recovery without converting it into another team or model", async () => {
    const service = createFakeTeamService({
      replaceMember: async () => { throw new TeamMemberReplacementError("stale_member", "The current task changed.") },
    })
    const result = await runTeamReplaceMember(service, input)
    expect(result.details).toEqual({ kind: "replacement_rejected", code: "stale_member", reason: "The current task changed." })
    expect(service.calls).toHaveLength(1)
  })
})
