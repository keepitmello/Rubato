import { describe, expect, it } from "vite-plus/test";

import type { BoardGroup, BoardItem, BoardNode, StatusBoard } from "../state/rubatoStatusBoard";
import { STALL_AFTER_MS } from "./rubatoLiveness";
import {
  PAST_AFTER_MS,
  boardCounts,
  boardSections,
  combinedLog,
  formatSpan,
  groupViews,
  leadBlocks,
  shortModelName,
  unavailableReason,
  workReason,
} from "./rubatoStatusBoardModel";

const NOW = Date.parse("2026-11-10T07:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
const resting = (id: string, quietMs: number) => node(id, { turnOpen: false, status: "completed", lastActivityAt: NOW - quietMs });
const item = (id: string, status: BoardItem["status"], updatedAgoMs: number): BoardItem => ({
  id, subject: `item ${id}`, status, owner: null, blockedBy: [], updatedAt: NOW - updatedAgoMs,
});

const team = (id: string, members: BoardNode[], overrides: Partial<BoardGroup> = {}): BoardGroup => ({
  kind: "team",
  id,
  name: id,
  status: "active",
  cwd: "/work",
  startedAt: NOW - 600_000,
  // The lead is the person's own conversation: busy with other work, it never keeps a team current.
  lead: node("lead", { role: "lead", turnOpen: true, lastActivityAt: NOW - 1_000 }),
  members,
  board: [],
  log: [],
  ...overrides,
});

const board = (groups: BoardGroup[]): StatusBoard => ({ version: "v", groups, clockOffset: 0 });
const ids = (views: ReadonlyArray<{ group: BoardGroup }>) => views.map((view) => view.group.id);

describe("order", () => {
  it("lists the newest-created first, ties by id, an unknown start last", () => {
    const { current } = boardSections(
      board([
        team("old", [node("a")], { startedAt: NOW - 5 * HOUR }),
        team("b-tie", [node("b")], { startedAt: NOW - HOUR }),
        team("a-tie", [node("c")], { startedAt: NOW - HOUR }),
        team("unknown", [node("d")], { startedAt: null }),
        team("new", [node("e")], { startedAt: NOW - 60_000 }),
      ]),
      NOW,
    );
    expect(ids(current)).toEqual(["new", "a-tie", "b-tie", "old", "unknown"]);
  });

  it("keeps the order when activity changes: created time, not the last move, decides", () => {
    const older = team("older", [node("a", { lastActivityAt: NOW - 1_000 })], { startedAt: NOW - 3 * HOUR });
    const newer = team("newer", [resting("b", 2 * HOUR)], { startedAt: NOW - HOUR });
    expect(ids(boardSections(board([older, newer]), NOW).current)).toEqual(["newer", "older"]);
  });
});

describe("past teams", () => {
  const stale = (id: string, startedAgo: number) =>
    team(id, [resting(`${id}-m`, 30 * DAY)], { startedAt: NOW - startedAgo, board: [item("1", "in_progress", 30 * DAY)] });

  it("folds a team whose members and work have been quiet over a day, even while its status says active", () => {
    const { current, past } = boardSections(
      board([stale("first-trial", 49 * DAY), stale("anticlump", 30 * DAY), team("now", [node("x")])]),
      NOW,
    );
    expect(ids(current)).toEqual(["now"]);
    // Expanded, newest first; nothing is dropped.
    expect(ids(past)).toEqual(["anticlump", "first-trial"]);
    expect(past[0]?.members.length).toBe(1);
  });

  it("does not fold a team whose members never wrote a transcript but which started today", () => {
    const fresh = team("fresh", [node("m", { lastActivityAt: null, lifecycle: "lost" })], { startedAt: NOW - HOUR });
    expect(ids(boardSections(board([fresh]), NOW).current)).toEqual(["fresh"]);
  });

  it("brings a team back when a member or a work item moves again", () => {
    const moved = team("moved", [resting("m", 30 * DAY), node("n", { lastActivityAt: NOW - 1_000 })], { startedAt: NOW - 30 * DAY });
    const touched = team("touched", [resting("m", 30 * DAY)], { startedAt: NOW - 30 * DAY, board: [item("1", "pending", 60_000)] });
    expect(ids(boardSections(board([moved, touched]), NOW).current)).toEqual(["moved", "touched"]);
  });

  it("folds at just over the day, not before", () => {
    const at = (quiet: number) => team("t", [resting("m", quiet)], { startedAt: NOW - quiet, board: [] });
    expect(boardSections(board([at(PAST_AFTER_MS)]), NOW).current).toHaveLength(1);
    expect(boardSections(board([at(PAST_AFTER_MS + 1_000)]), NOW).past).toHaveLength(1);
  });

  it("counts only current work for the badge and the header", () => {
    const counts = boardCounts(board([stale("old", 40 * DAY), team("now", [node("x")])]), NOW);
    expect(counts).toMatchObject({ working: 1, teams: 1, past: 1 });
  });
});

describe("where a team's work stands", () => {
  const work = (group: BoardGroup, at = NOW) => groupViews(board([group]), at)[0]!.work;

  it("is completed when every item is done and nobody is in a turn, though members stay resident", () => {
    const done = team("rubato-board", [resting("builder", 2 * HOUR), resting("checker", 2 * HOUR)], {
      board: [item("1", "completed", 2 * HOUR), item("2", "completed", 2 * HOUR)],
    });
    expect(work(done)).toMatchObject({ state: "completed", open: 0, total: 2 });
    // Members are honestly waiting, not "done": their sessions are still there.
    expect(groupViews(board([done]), NOW)[0]?.members.map((member) => member.liveness)).toEqual(["resting", "resting"]);
    expect(workReason(work(done), NOW)).toBe("All 2 work items are done · members are free for new work");
  });

  it("waits briefly, then stalls, when work remains and nobody is in a turn", () => {
    const idle = (quiet: number) =>
      team("imgbox", [resting("builder2", quiet), resting("checker2", quiet)], {
        board: [item("7", "in_progress", quiet), item("8", "in_progress", quiet), item("1", "completed", DAY)],
      });
    expect(work(idle(60_000)).state).toBe("waiting");
    expect(work(idle(STALL_AFTER_MS - 1_000)).state).toBe("waiting");
    const stalled = work(idle(STALL_AFTER_MS));
    expect(stalled).toMatchObject({ state: "stalled", reason: "work-left", open: 2 });
    expect(workReason(stalled, NOW)).toMatch(/^2 work items left · no member has worked since \d\d:\d\d$/);
  });

  it("clears on resumed work or a new assignment", () => {
    const quiet = 2 * HOUR;
    const resumed = team("t", [node("builder"), resting("checker", quiet)], { board: [item("1", "in_progress", quiet)] });
    expect(work(resumed).state).toBe("working");
    const reassigned = team("t", [resting("builder", quiet)], {
      board: [item("1", "completed", quiet), item("2", "pending", 30_000)],
    });
    expect(work(reassigned).state).toBe("waiting");
  });

  it("calls a member's quiet open turn a stall of the team too", () => {
    const quiet = team("t", [node("m", { lastActivityAt: NOW - STALL_AFTER_MS - 1 })], { board: [item("1", "in_progress", HOUR)] });
    expect(work(quiet)).toMatchObject({ state: "stalled", reason: "member-quiet" });
    // Counted once, as the stalled member, not again as a stalled team.
    expect(boardCounts(board([quiet]), NOW)).toMatchObject({ stalled: 1, stalledTeams: 0 });
  });

  it("reads the whole board's count when the server sent only part of the items", () => {
    // 41 items: #1 in progress, touched a minute ago; the forty shown are all done and old.
    const shown = Array.from({ length: 40 }, (_, index) => item(String(index + 2), "completed", 2 * DAY));
    const long = team("long", [resting("m", 2 * DAY)], {
      startedAt: NOW - 3 * DAY,
      board: shown,
      boardSummary: { total: 41, open: 1, updatedAt: NOW - 60_000 },
    });
    const sections = boardSections(board([long]), NOW);
    expect(ids(sections.current)).toEqual(["long"]);
    expect(sections.current[0]?.work).toMatchObject({ state: "waiting", open: 1, total: 41 });
  });
});

describe("filters and counts", () => {
  const value = board([
    team("imgbox", [
      node("builder2"),
      node("checker2", { turnOpen: false }),
      node("evicted", { lifecycle: "lost" }),
      node("quiet", { lastActivityAt: NOW - STALL_AFTER_MS - 1 }),
      node("builder", { lifecycle: "stopped" }),
    ]),
  ]);

  it("counts members by liveness", () => {
    expect(boardCounts(value, NOW)).toEqual({ working: 1, stalled: 1, resting: 1, lost: 1, ended: 1, teams: 1, stalledTeams: 0, past: 0 });
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

  it("filters members by state; a team whose work stalled shows whole under Stalled", () => {
    expect(groupViews(value, NOW, "stalled")[0]?.members.map((member) => member.node.id)).toEqual(["quiet"]);
    expect(groupViews(board([team("idle", [node("a", { turnOpen: false })])]), NOW, "working")).toEqual([]);
    const stuck = team("stuck", [resting("a", HOUR), resting("b", HOUR)], { board: [item("1", "pending", HOUR)] });
    expect(groupViews(board([stuck]), NOW, "stalled")[0]?.members).toHaveLength(2);
    expect(boardCounts(board([stuck]), NOW)).toMatchObject({ stalled: 0, stalledTeams: 1 });
  });
});

describe("opening a card's conversation", () => {
  const lead = { hostSessionId: "s1", agentId: null, history: true };
  const member = { hostSessionId: "s1", agentId: "st_1", history: true };
  it("opens when the app shows the host session's thread", () => {
    expect(unavailableReason(lead, "thread-1")).toBeNull();
    expect(unavailableReason(member, "thread-1")).toBeNull();
  });
  it("says why it can't, and never makes a conversation up", () => {
    expect(unavailableReason(lead, undefined)).toBeUndefined();
    expect(unavailableReason(lead, null)).toBe("Its conversation isn't in the app");
    expect(unavailableReason({ ...member, history: false }, "thread-1")).toBe("No saved conversation");
    expect(unavailableReason({ hostSessionId: null, agentId: "st_2", history: true, reason: "nested" }, undefined)).toBe(
      "Opens inside its parent agent's conversation",
    );
    expect(unavailableReason(null, undefined)).toBe("Not linked to a conversation");
  });
});

describe("names and log", () => {
  it("counts run time in minutes, hours, then days", () => {
    expect(formatSpan(NOW - 12 * 60_000, NOW)).toBe("12m");
    expect(formatSpan(NOW - (2 * HOUR + 7 * 60_000), NOW)).toBe("2h 07m");
    expect(formatSpan(NOW - (30 * DAY + 4 * HOUR), NOW)).toBe("30d 4h");
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
        team("a", [node("m1")], { log: [{ at: NOW - 3_000, who: "m1", role: "owner", text: "third" }] }),
        team("b", [node("m2")], {
          startedAt: NOW - 700_000,
          log: [
            { at: NOW - 9_000, who: "m2", role: "owner", text: "first" },
            { at: NOW - 1_000, who: "lead", role: "lead", text: "last" },
          ],
        }),
      ]),
      NOW,
    );
    expect(combinedLog(views).map((line) => `${line.group}/${line.text}`)).toEqual(["b/first", "a/third", "b/last"]);
  });
});

describe("one lead, its teams beneath", () => {
  const LEAD = "01a1b592-b752-708d-b41e-9347589cdfbb";
  const leadNode = (sessionId: string | null) => node("lead", { role: "lead", sessionId, lastActivityAt: NOW - 1_000 });
  const led = (id: string, sessionId: string | null, startedAgo: number, overrides: Partial<BoardGroup> = {}) =>
    team(id, [node(`${id}-m`)], { lead: leadNode(sessionId), startedAt: NOW - startedAgo, ...overrides });
  const keys = (blocks: ReturnType<typeof leadBlocks>) => blocks.map((block) => [block.key.split("\u0000").at(-1), ids(block.groups)]);

  it("shows two teams sharing one lead conversation under one lead, newest team first", () => {
    const { current } = boardSections(board([led("imgbox", LEAD, 3 * DAY), led("rubato-board", LEAD, HOUR)]), NOW);
    const blocks = leadBlocks(current);
    expect(keys(blocks)).toEqual([[LEAD, ["rubato-board", "imgbox"]]]);
    // The one card's destination is that conversation.
    expect(blocks[0]?.lead.node.sessionId).toBe(LEAD);
  });

  it("keeps distinct conversations apart even when both are called Lead", () => {
    const blocks = leadBlocks(boardSections(board([led("a", "s-1", HOUR), led("b", "s-2", 2 * HOUR)]), NOW).current);
    expect(blocks.map((block) => block.lead.node.name)).toEqual(["lead", "lead"]);
    expect(keys(blocks)).toEqual([["s-1", ["a"]], ["s-2", ["b"]]]);
  });

  it("keeps the same session id in two environments apart", () => {
    const blocks = leadBlocks(
      boardSections(board([led("a", "same", HOUR, { environmentId: "env-1" }), led("b", "same", 2 * HOUR, { environmentId: "env-2" })]), NOW).current,
    );
    expect(blocks).toHaveLength(2);
  });

  it("never merges leads it cannot identify, not even one team run id seen in two environments", () => {
    expect(leadBlocks(boardSections(board([led("a", null, HOUR), led("b", null, 2 * HOUR)]), NOW).current)).toHaveLength(2);
    const twin = (environmentId: string) => led("run-1", null, HOUR, { environmentId });
    expect(leadBlocks(boardSections(board([twin("env-1"), twin("env-2")]), NOW).current)).toHaveLength(2);
  });

  it("orders blocks by their newest team, and teams newest first inside", () => {
    const blocks = leadBlocks(
      boardSections(board([led("c", "l1", 3 * HOUR), led("b", "l2", 2 * HOUR), led("a", "l1", HOUR)]), NOW).current,
    );
    expect(keys(blocks)).toEqual([["l1", ["a", "c"]], ["l2", ["b"]]]);
  });

  it("folds a shared lead's old team on its own, and expanding it shows no second lead", () => {
    const old = led("old", LEAD, 40 * DAY, { members: [resting("old-m", 30 * DAY)], board: [item("1", "in_progress", 30 * DAY)] });
    const elsewhere = led("elsewhere", "other-lead", 45 * DAY, { members: [resting("e-m", 30 * DAY)] });
    const sections = boardSections(board([led("now", LEAD, HOUR), old, elsewhere]), NOW);
    const current = leadBlocks(sections.current);
    const past = leadBlocks(sections.past, new Set(current.map((block) => block.key)));
    expect(keys(current)).toEqual([[LEAD, ["now"]]]);
    expect(past.map((block) => [ids(block.groups), block.leadShownAbove])).toEqual([[["old"], true], [["elsewhere"], false]]);
    // The old team keeps its own state.
    expect(past[0]?.groups[0]?.work.state).toBe("stalled");
  });

  it("keeps each team's state and counts members once, the shared lead not at all", () => {
    const done = led("done", LEAD, 2 * HOUR, { members: [resting("w", HOUR)], board: [item("1", "completed", HOUR)] });
    const working = led("working", LEAD, HOUR);
    const value = board([done, working]);
    const [block] = leadBlocks(boardSections(value, NOW).current);
    expect(block?.groups.map((view) => [view.group.id, view.work.state])).toEqual([["working", "working"], ["done", "completed"]]);
    expect(boardCounts(value, NOW)).toMatchObject({ working: 1, resting: 1, teams: 2 });
  });

  it("says a shared lead's lines once in the log, its teams' members under their names", () => {
    const say = (at: number, who: string, role: string, text: string) => ({ at: NOW - at, who, role, text });
    const views = boardSections(
      board([
        led("a", LEAD, HOUR, { log: [say(5_000, "lead", "lead", "Both teams started."), say(3_000, "a-m", "owner", "a works")] }),
        led("b", LEAD, 2 * HOUR, { log: [say(5_000, "lead", "lead", "Both teams started."), say(1_000, "b-m", "owner", "b works")] }),
      ]),
      NOW,
    ).current;
    expect(combinedLog(views).map((line) => `${line.group ?? "-"}/${line.who}: ${line.text}`)).toEqual([
      "-/lead: Both teams started.",
      "a/a-m: a works",
      "b/b-m: b works",
    ]);
  });
});
