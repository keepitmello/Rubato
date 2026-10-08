import { describe, expect, test } from "bun:test"
import { Value } from "typebox/value"
import { TeamMemberAddError } from "../../team"
import { createFakeTeamService, fakeCreatedMember } from "./__fixtures__/team-tool-fakes"
import { type TeamAddMemberInput, createTeamAddMemberTool, runTeamAddMember } from "./add-member"

const input = {
  team_run_id: "00000000-0000-4000-8000-000000000000",
  name: "gamma", kind: "verifier" as const, model: "rubato-mock/mock-1",
  prompt: "Verify revision B against intent-7; coordinate with alpha.",
}

describe("team_add_member tool", () => {
  test("maps the request onto the service and reports the new member", async () => {
    const service = createFakeTeamService({
      addMember: async () => ({
        teamRunId: input.team_run_id,
        member: fakeCreatedMember({ name: "gamma", taskId: "st_new", role: { kind: "verifier", model: input.model } }),
      }),
    })
    const result = await runTeamAddMember(service, { ...input, effort: "high", task_summary: "Verify B" })
    expect(service.calls).toEqual([{
      method: "addMember",
      args: [{
        teamRunId: input.team_run_id, name: "gamma", kind: "verifier", model: input.model,
        prompt: input.prompt, effort: "high", taskSummary: "Verify B",
      }],
    }])
    expect(result.details).toMatchObject({ kind: "added", member: { name: "gamma", task_id: "st_new", role: "verifier" } })
  })

  test("reports a refusal without starting anything else", async () => {
    const service = createFakeTeamService({
      addMember: async () => { throw new TeamMemberAddError("name_taken", "The team already has or had a member named 'gamma'.") },
    })
    const result = await runTeamAddMember(service, input)
    expect(result.details).toEqual({ kind: "add_rejected", code: "name_taken", reason: "The team already has or had a member named 'gamma'." })
    expect(service.calls).toHaveLength(1)
  })

  test("requires a brief and a catalog model, and truncates an over-long summary", () => {
    const tool = createTeamAddMemberTool({
      service: createFakeTeamService(), models: { has: () => true, list: () => ["rubato-mock/mock-1"] },
    })
    expect(Value.Check(tool.parameters, input)).toBe(true)
    expect(Value.Check(tool.parameters, { ...input, prompt: "" })).toBe(false)
    expect(Value.Check(tool.parameters, { ...input, model: "missing/model" })).toBe(false)
    expect(Value.Check(tool.parameters, { ...input, kind: "lead" })).toBe(false)
    const prepared = tool.prepareArguments!({ ...input, task_summary: "x".repeat(120) }) as TeamAddMemberInput
    expect(Value.Check(tool.parameters, prepared)).toBe(true)
    expect(tool.description).toContain("team_approve_shutdown")
  })
})
