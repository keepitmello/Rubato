import { describe, expect, it } from "vite-plus/test";

import type { BoardGroup, BoardNode, StatusBoard } from "../state/rubatoStatusBoard";
import { STALL_AFTER_MS } from "./rubatoLiveness";
import { boardCounts, combinedLog, groupViews, shortModelName } from "./rubatoStatusBoardModel";

const NOW = Date.parse("2026-11-10T07:00:00.000Z");

const node = (id: string, overrides: Partial<BoardNode> = {}): BoardNode => ({
  id,
  sessionId: null,
  name: id,
  role: "owner",
  task: null,
  model: "anthropic/claude-opus-5-5",
  effort: null,
  status: "running",
  lifecycle: "live",
  turnOpen: true,
  pendingTool: null,
  lastActivityAt: NOW - 5_000,
  startedAt: NOW - 600_000,
  endedAt: null,
  narration: null,
  steps: [],
  toolCalls: 3,
  messages: 2,
  parentSessionId: null,
  ...overrides,
});

const team = (id: string, members: BoardNode[], log: BoardGroup["log"] = []): BoardGroup => ({
  kind: "team",
  id,
  name: id,
  status: "active",
  cwd: "/work",
  startedAt: NOW - 600_000,
  lead: node("lead", { role: "lead", lifecycle: "live", turnOpen: false }),
  members,
  board: [],
  log,
});

const board = (groups: BoardGroup[]): StatusBoard => ({ version: "v", groups, clockOffset: 0 });

describe("the status board model", () => {
  const value = board([
    team("imgbox", [
      node("builder2"),
      node("checker2", { turnOpen: false }),
      node("evicted", { lifecycle: "lost" }),
      node("quiet", { lastActivityAt: NOW - STALL_AFTER_MS - 1 }),
      node("builder", { lifecycle: "stopped" }),
    ]),
  ]);

  it("counts members by liveness for the badge and the header", () => {
    expect(boardCounts(value, NOW)).toEqual({ working: 1, stalled: 1, resting: 1, lost: 1, ended: 1, teams: 1 });
    expect(boardCounts(null, NOW).working).toBe(0);
  });

  it("lists running and lost members, and puts ended ones on their own line", () => {
    const [view] = groupViews(value, NOW);
    expect(view?.members.map((member) => [member.node.id, member.liveness])).toEqual([
      ["builder2", "working"],
      ["checker2", "resting"],
      ["evicted", "lost"],
      ["quiet", "stalled"],
    ]);
    expect(view?.ended.map((member) => member.node.id)).toEqual(["builder"]);
  });

  it("filters members by state and drops groups with none", () => {
    expect(groupViews(value, NOW, "stalled")[0]?.members.map((member) => member.node.id)).toEqual(["quiet"]);
    expect(groupViews(board([team("idle", [node("a", { turnOpen: false })])]), NOW, "working")).toEqual([]);
  });

  it("names models as people say them, the catalogue first", () => {
    expect(shortModelName("anthropic/claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("openai-codex/gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(shortModelName("x/y", new Map([["x/y", "Named"]]))).toBe("Named");
    expect(shortModelName(null)).toBeNull();
  });

  it("merges every group's log in time order and names the group when there are several", () => {
    const views = groupViews(
      board([
        team("a", [node("m1")], [{ at: NOW - 3_000, who: "m1", role: "owner", text: "third" }]),
        team("b", [node("m2")], [
          { at: NOW - 9_000, who: "m2", role: "owner", text: "first" },
          { at: NOW - 1_000, who: "lead", role: "lead", text: "last" },
        ]),
      ]),
      NOW,
    );
    expect(combinedLog(views).map((line) => `${line.group}/${line.text}`)).toEqual(["b/first", "a/third", "b/last"]);
  });
});
