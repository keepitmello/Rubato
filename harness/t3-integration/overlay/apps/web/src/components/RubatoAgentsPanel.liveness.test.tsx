import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BoardNode, StatusBoard } from "../state/rubatoStatusBoard";
import { deriveAgentPanelModel, type RubatoSubagent } from "./rubatoAgentPanelModel";
import { STALL_AFTER_MS } from "./rubatoLiveness";

// The thread's timeline pulls in the diff worker, which a node test cannot load.
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));

const NOW = Date.parse("2026-11-10T07:00:00.000Z");
const node = (id: string, overrides: Partial<BoardNode>): BoardNode => ({
  id, sessionId: null, task: null, model: null, effort: null, status: "running", lifecycle: "live", turnOpen: true,
  pendingTool: null, lastActivityAt: NOW - 12_000, startedAt: NOW - 600_000, endedAt: null, narration: null, steps: [],
  toolCalls: null, messages: null, parentSessionId: null, ...overrides,
});
const BOARD: StatusBoard = {
  version: "v",
  clockOffset: 0,
  groups: [{
    kind: "agents", id: "agents:lead", name: null, status: null, cwd: "/work", startedAt: NOW - 600_000,
    lead: node("lead", { role: "lead" }), board: null, log: [],
    members: [
      node("st_working", {}),
      node("st_stalled", { lastActivityAt: NOW - STALL_AFTER_MS - 60_000 }),
      node("st_lost", { lifecycle: "lost" }),
    ],
  }],
};
// The panel reads the status board's answer: here a fixed one, at a fixed now.
vi.mock("../state/rubatoStatusBoard", () => ({
  useStatusBoard: () => BOARD,
  useBoardNodes: (board: StatusBoard | null) => new Map((board?.groups ?? []).flatMap((group) => group.members.map((member) => [member.id, member]))),
  useBoardNow: () => NOW,
  BOARD_STATE_STEP_MS: 5_000,
}));

const { RubatoAgentsPanel } = await import("./RubatoAgentsPanel");

const agent = (id: string): RubatoSubagent => ({
  id, kind: "subagent", title: id, label: `Task ${id}`, modelLabel: "Opus 5.5 · High", memberName: null, board: null,
  awaiting: [], assignment: null, role: null, model: "anthropic/claude-opus-5-5", effort: "high", status: "running",
  activationCount: 1, usage: null, progress: `Doing ${id}`, lastToolName: null, result: null, error: null, outputFile: null,
  parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: null, workflowName: null, phases: [],
  runHandles: null, childThreadId: null, recentActivity: [], firstSeenAt: "2026-11-10T06:50:00.000Z",
  startedAt: "2026-11-10T06:50:00.000Z", completedAt: null, updatedAt: "2026-11-10T06:59:00.000Z",
});

describe("the Agents panel's liveness", () => {
  it("says what the status board says: working with its last move, stalled and lost even while the record runs", () => {
    const html = renderToStaticMarkup(
      <RubatoAgentsPanel model={deriveAgentPanelModel({ agents: [agent("st_working"), agent("st_stalled"), agent("st_lost"), agent("st_unknown")] })} />,
    );
    const row = (id: string) => html.split("<button").find((part) => part.includes(`aria-label="Task ${id}:`)) ?? "";
    expect(row("st_working")).toContain('data-liveness="working"');
    expect(row("st_working")).toContain("12s ago");
    expect(row("st_stalled")).toContain('data-liveness="stalled"');
    expect(row("st_stalled")).toContain("Stalled");
    expect(row("st_stalled")).toContain("6m ago");
    expect(row("st_lost")).toContain('data-liveness="lost"');
    expect(row("st_lost")).toContain("Lost");
    // An agent the board has not read keeps the panel's own words.
    expect(row("st_unknown")).not.toContain("data-liveness");
    // The totals count each row as it reads: two working, one stalled, one lost.
    const footer = html.slice(html.lastIndexOf("<footer")).replace(/<[^>]*>/g, "");
    expect(footer).toContain("● 2 working");
    expect(footer).toContain("1 stalled");
    expect(footer).toContain("1 lost");
  });
});
