import { describe, expect, test } from "bun:test"

import { SenpiShutdownError } from "../../team"
import { createFakeTeamService, fakeRuntimeState } from "./__fixtures__/team-tool-fakes"
import {
  createTeamApproveShutdownTool,
  createTeamRejectShutdownTool,
  createTeamShutdownRequestTool,
  runTeamApproveShutdown,
  runTeamRejectShutdown,
  runTeamShutdownRequest,
} from "./shutdown"

describe("shutdown request route", () => {
  test("#given a member #when request runs #then it reports requested", async () => {
    const service = createFakeTeamService({ requestShutdown: async () => fakeRuntimeState({ status: "shutdown_requested" }) })
    const result = await runTeamShutdownRequest(service, { team_run_id: "run-1", member: "alpha" })
    expect(result.details).toMatchObject({ kind: "requested", member: "alpha" })
    expect(service.calls[0]).toMatchObject({ method: "requestShutdown", args: ["run-1", "alpha"] })
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("'alpha'")
    expect(text).toContain("run-1")
  })

  test("#given an unknown member #when request runs #then it reports unknown_member", async () => {
    const service = createFakeTeamService({
      requestShutdown: async () => {
        throw new SenpiShutdownError("unknown", "unknown_member", "run-1", "ghost")
      },
    })
    const result = await runTeamShutdownRequest(service, { team_run_id: "run-1", member: "ghost" })
    expect(result.details).toMatchObject({ kind: "unknown_member", member: "ghost" })
  })
})

describe("shutdown approve route", () => {
  test("#given a pending request #when approve runs #then it reports approved", async () => {
    const service = createFakeTeamService({ approveShutdown: async () => fakeRuntimeState() })
    const result = await runTeamApproveShutdown(service, { team_run_id: "run-1", member: "alpha" })
    expect(result.details).toMatchObject({ kind: "approved", member: "alpha" })
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("'alpha'")
    expect(text).toContain("run-1")
  })

  test("#given no pending request #when approve runs #then it reports no_pending_request", async () => {
    const service = createFakeTeamService({
      approveShutdown: async () => {
        throw new SenpiShutdownError("none", "no_pending_request", "run-1", "alpha")
      },
    })
    const result = await runTeamApproveShutdown(service, { team_run_id: "run-1", member: "alpha" })
    expect(result.details).toMatchObject({ kind: "no_pending_request", member: "alpha" })
  })
})

describe("shutdown reject route", () => {
  test("#given a pending request #when reject runs #then it reports rejected with the reason", async () => {
    const service = createFakeTeamService({ rejectShutdown: async () => fakeRuntimeState() })
    const result = await runTeamRejectShutdown(service, { team_run_id: "run-1", member: "alpha", reason: "keep going" })
    expect(result.details).toMatchObject({ kind: "rejected", member: "alpha", reason: "keep going" })
    expect(service.calls[0]).toMatchObject({ method: "rejectShutdown", args: ["run-1", "alpha", "keep going"] })
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("'alpha'")
    expect(text).toContain("run-1")
    expect(text).toContain("keep going")
  })

  test("#given no pending request #when reject runs #then it reports no_pending_request", async () => {
    const service = createFakeTeamService({
      rejectShutdown: async () => {
        throw new SenpiShutdownError("none", "no_pending_request", "run-1", "alpha")
      },
    })
    const result = await runTeamRejectShutdown(service, { team_run_id: "run-1", member: "alpha", reason: "no" })
    expect(result.details.kind).toBe("no_pending_request")
  })
})

describe("lead shutdown tools", () => {
  test("#given the factories #when built #then they register dedicated team_* shutdown names", () => {
    const deps = { service: createFakeTeamService() }
    expect(createTeamShutdownRequestTool(deps).name).toBe("team_shutdown_request")
    expect(createTeamApproveShutdownTool(deps).name).toBe("team_approve_shutdown")
    expect(createTeamRejectShutdownTool(deps).name).toBe("team_reject_shutdown")
  })

  test("#given a lead shutdown request tool #when executed #then requestShutdown runs for that member", async () => {
    const service = createFakeTeamService({ requestShutdown: async () => fakeRuntimeState() })
    const tool = createTeamShutdownRequestTool({ service })

    const result = await tool.execute(
      "call-1",
      { team_run_id: "run-1", member: "alpha" },
      undefined,
      undefined,
      {} as never,
    )

    expect(result.details).toMatchObject({ kind: "requested", team_run_id: "run-1", member: "alpha" })
    expect(service.calls[0]).toMatchObject({ method: "requestShutdown", args: ["run-1", "alpha"] })
  })

  test("#given a lead approve then reject tool #when executed #then each completes the shutdown protocol", async () => {
    const service = createFakeTeamService({
      approveShutdown: async () => fakeRuntimeState(),
      rejectShutdown: async () => fakeRuntimeState(),
    })

    const approved = await createTeamApproveShutdownTool({ service }).execute(
      "call-2",
      { team_run_id: "run-1", member: "alpha" },
      undefined,
      undefined,
      {} as never,
    )
    const rejected = await createTeamRejectShutdownTool({ service }).execute(
      "call-3",
      { team_run_id: "run-1", member: "alpha", reason: "still needed" },
      undefined,
      undefined,
      {} as never,
    )

    expect(approved.details).toMatchObject({ kind: "approved", member: "alpha" })
    expect(rejected.details).toMatchObject({ kind: "rejected", member: "alpha", reason: "still needed" })
    expect(service.calls.map((call) => call.method)).toEqual(["approveShutdown", "rejectShutdown"])
  })
})
