import { describe, expect, it } from "vite-plus/test";

import type { RubatoSessionState } from "../state/rubatoSessionState";
import { deriveAgentPanelModel, rubatoAgentsFromSessionState } from "./rubatoAgentPanelModel";

const AT = "2026-10-16T10:00:00.000Z";
const LATER = "2026-10-16T10:05:00.000Z";

const state: RubatoSessionState = {
  cache: null,
  speedIndex: 176,
  agents: [
    {
      taskId: "st_solo",
      title: "opus-5-5 · high · Review the port",
      label: "Review the port",
      modelLabel: "Opus 5.5 · High",
      status: "running",
      activity: "Reading apply.mjs",
      speedIndex: 140,
      turns: 7,
      startedAt: AT,
      updatedAt: LATER,
    },
    {
      taskId: "st_backend",
      title: "backend",
      memberName: "backend",
      teamRunId: "team-1",
      status: "completed",
      result: "Adapter on V2, commit 90fc869.",
      startedAt: AT,
      updatedAt: LATER,
      completedAt: LATER,
    },
    {
      taskId: "st_ui",
      title: "ui",
      memberName: "ui",
      status: "stopped",
      error: "Stopped by the lead.",
      startedAt: AT,
      updatedAt: LATER,
    },
  ],
  teams: [
    {
      teamRunId: "team-1",
      name: "t3-v2-port",
      members: ["st_backend", "st_ui"],
      board: {
        tasks: [
          { id: "1", subject: "ui: re-anchor", description: "…", status: "in_progress", owner: "ui", blockedBy: [] },
          { id: "2", subject: "server: adapter", description: "…", status: "completed", owner: "backend" },
        ],
      },
    },
  ],
};

describe("Agents panel rows from the server's session state", () => {
  const model = deriveAgentPanelModel({ agents: rubatoAgentsFromSessionState(state) });

  it("puts a taskforce's members and board on its card, the rest as direct agents", () => {
    expect(model.workflows).toHaveLength(1);
    const team = model.workflows[0]!;
    expect(team.workflow.title).toBe("t3-v2-port");
    expect(team.workflow.board?.tasks.map((task) => [task.id, task.status, task.owner])).toEqual([
      ["1", "in_progress", "ui"],
      ["2", "completed", "backend"],
    ]);
    // A member is found by the team's member list even when its own record omits the team.
    expect(team.unphasedMembers.map((member) => member.id)).toEqual(["st_backend", "st_ui"]);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["st_solo"]);
  });

  it("keeps each agent's own words, model name, Speed, turns and how it ended", () => {
    const solo = model.directAgents[0]!;
    expect([solo.label, solo.modelLabel, solo.usage?.speedIndex, solo.usage?.turns, solo.progress]).toEqual([
      "Review the port",
      "Opus 5.5 · High",
      140,
      7,
      "Reading apply.mjs",
    ]);
    const [backend, ui] = model.workflows[0]!.unphasedMembers;
    expect([backend!.status, backend!.result]).toEqual(["completed", "Adapter on V2, commit 90fc869."]);
    expect([ui!.status, ui!.error]).toEqual(["cancelled", "Stopped by the lead."]);
  });

  it("counts the solo agent as live and the team card as no work of its own", () => {
    expect(model.liveCount).toBe(1);
    expect(model.settledCount).toBe(2);
  });

  it("has no rows when the engine knows no agents", () => {
    expect(deriveAgentPanelModel({ agents: rubatoAgentsFromSessionState({ speedIndex: null, cache: null, agents: [], teams: [] }) }).hasAgents).toBe(false);
  });
});
