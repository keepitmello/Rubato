import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  EMPTY_PROJECT_LIST_STATE,
  RUBATO_QUIET_AFTER_MS,
  addToProjectList,
  anyNeedsUser,
  lastActivityByGroup,
  moveInProjectList,
  projectListInOrder,
  removeFromProjectList,
  resolveProjectList,
  resolveThreadSignal,
  scopedNewThreadProjectRef,
  selectHomeThreads,
  selectRecentThreads,
  signalByGroup,
  filterProjectList,
  strongerSignal,
  strongestUrgentSignal,
  urgentSignal,
} from "./rubatoProjectRail.logic";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;

const group = (projectKey: string) => ({
  projectKey,
  memberProjectRefs: [{ environmentId: "env", projectId: projectKey }],
});

function thread(
  id: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env",
    projectId,
    title: id,
    createdAt: ago(48 * HOUR),
    archivedAt: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
    pinnedAt: null,
    settledOverride: null,
    snoozedAt: null,
    snoozedUntil: null,
    latestRun: null,
    latestUserAuthoredMessageAt: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    lastVisitedAt: undefined,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const run = (completedAt: string | null, requestedAt = completedAt) => ({
  runId: "run",
  status: completedAt ? "completed" : "running",
  requestedAt,
  completedAt,
});

describe("the shared project list", () => {
  const groups = [group("a"), group("b"), group("c")];
  const lastActivity = new Map([
    ["a", NOW - HOUR],
    ["b", NOW - 3 * HOUR],
    ["c", NOW - RUBATO_QUIET_AFTER_MS - HOUR],
  ]);

  it("follows activity until the first edit: last week's projects listed, newest first", () => {
    const list = resolveProjectList({ groups, state: EMPTY_PROJECT_LIST_STATE, lastActivity, now: NOW });
    expect(list.listed.map((g) => g.projectKey)).toEqual(["a", "b"]);
    expect(list.quiet.map((g) => g.projectKey)).toEqual(["c"]);
  });

  it("freezes the shown order on the first remove and keeps the user's order after", () => {
    const list = resolveProjectList({ groups, state: EMPTY_PROJECT_LIST_STATE, lastActivity, now: NOW });
    const removed = removeFromProjectList(list, "a");
    expect(removed).toEqual({ order: ["b"], hidden: ["a", "c"] });
    // Activity no longer reorders an edited list.
    const later = new Map([...lastActivity, ["c", NOW]]);
    const after = resolveProjectList({ groups, state: removed, lastActivity: later, now: NOW });
    expect(after.listed.map((g) => g.projectKey)).toEqual(["b"]);
    expect(after.quiet.map((g) => g.projectKey)).toEqual(["a", "c"]);
  });

  it("adds to the end and moves to where the drag ended", () => {
    const list = resolveProjectList({ groups, state: EMPTY_PROJECT_LIST_STATE, lastActivity, now: NOW });
    const added = addToProjectList(list, "c");
    expect(added).toEqual({ order: ["a", "b", "c"], hidden: [] });
    const addedList = resolveProjectList({ groups, state: added, lastActivity, now: NOW });
    expect(moveInProjectList(addedList, "c", "a")).toEqual({ order: ["c", "a", "b"], hidden: [] });
    expect(moveInProjectList(addedList, "a", "c")).toEqual({ order: ["b", "c", "a"], hidden: [] });
  });

  it("moves across sections when a drag ends on a project in the other one", () => {
    const list = resolveProjectList({ groups, state: EMPTY_PROJECT_LIST_STATE, lastActivity, now: NOW });
    // c is quiet; dropped on a it joins the user's projects in a's place.
    expect(moveInProjectList(list, "c", "a")).toEqual({ order: ["c", "a", "b"], hidden: [] });
    // b dropped on quiet c leaves the user's projects.
    expect(moveInProjectList(list, "b", "c")).toEqual({ order: ["a"], hidden: ["b", "c"] });
    // An unknown key leaves the list as it is.
    expect(moveInProjectList(list, "gone", "a")).toEqual({ order: ["a", "b"], hidden: ["c"] });
  });

  it("reads as one line for surfaces without sections: the user's projects, then the others", () => {
    const list = resolveProjectList({
      groups,
      state: { order: ["b"], hidden: ["c", "a"] },
      lastActivity,
      now: NOW,
    });
    expect(projectListInOrder(list).map((g) => g.projectKey)).toEqual(["b", "c", "a"]);
  });

  it("keeps projects in temporary folders quiet, before and after the first edit", () => {
    const temp = { ...group("t"), workspaceRoot: "/private/tmp/ww-eval/new/E1" };
    const groupsWithTemp = [...groups, temp];
    const activity = new Map([...lastActivity, ["t", NOW]]);
    const before = resolveProjectList({
      groups: groupsWithTemp,
      state: EMPTY_PROJECT_LIST_STATE,
      lastActivity: activity,
      now: NOW,
    });
    expect(before.listed.map((g) => g.projectKey)).toEqual(["a", "b"]);
    expect(before.quiet.map((g) => g.projectKey)).toEqual(["t", "c"]);
    const after = resolveProjectList({
      groups: groupsWithTemp,
      state: { order: ["a"], hidden: [] },
      lastActivity: activity,
      now: NOW,
    });
    expect(after.listed.map((g) => g.projectKey)).toEqual(["a", "b", "c"]);
    expect(after.quiet.map((g) => g.projectKey)).toEqual(["t"]);
  });

  it("lists a project created after the last edit, and drops projects that are gone", () => {
    const state = { order: ["b", "gone"], hidden: ["a"] };
    const list = resolveProjectList({ groups, state, lastActivity, now: NOW });
    expect(list.listed.map((g) => g.projectKey)).toEqual(["b", "c"]);
    expect(list.quiet.map((g) => g.projectKey)).toEqual(["a"]);
  });

  it("reads activity from sends and runs, not from archived threads", () => {
    const activity = lastActivityByGroup(groups, [
      thread("t1", "a", { latestUserAuthoredMessageAt: ago(2 * HOUR) }),
      thread("t2", "a", { latestRun: run(ago(HOUR)) }),
      thread("t3", "b", { latestRun: run(ago(10 * 60 * 1000)), archivedAt: ago(0) }),
    ]);
    expect(activity.get("a")).toBe(NOW - HOUR);
    expect(activity.has("b")).toBe(false);
  });
});

describe("signals", () => {
  it("ranks a request for the user above a failure, an unread finish and work", () => {
    expect(strongerSignal("working", "done")).toBe("done");
    expect(strongerSignal("done", "failed")).toBe("failed");
    expect(strongerSignal("attention", "failed")).toBe("attention");
    expect(strongerSignal(null, "working")).toBe("working");
  });

  it("reads a thread the way its sidebar row does", () => {
    expect(resolveThreadSignal(thread("t", "a", { hasPendingApprovals: true }), undefined)).toBe(
      "attention",
    );
    expect(resolveThreadSignal(thread("t", "a", { runtime: { status: "running" } }), undefined)).toBe(
      "working",
    );
    const finished = thread("t", "a", { latestRun: run(ago(HOUR)), lastVisitedAt: ago(2 * HOUR) });
    expect(resolveThreadSignal(finished, undefined)).toBe("done");
    const seen = thread("t", "a", { latestRun: run(ago(HOUR)), lastVisitedAt: ago(0) });
    expect(resolveThreadSignal(seen, undefined)).toBeNull();
  });

  it("gives each project its strongest thread", () => {
    const signals = signalByGroup(
      [group("a"), group("b")],
      [
        thread("t1", "a", { runtime: { status: "running" } }),
        thread("t2", "a", { hasPendingUserInput: true }),
        thread("t3", "b", { runtime: { status: "running" } }),
      ],
      {},
    );
    expect(signals.get("a")).toBe("attention");
    expect(signals.get("b")).toBe("working");
  });

  it("marks a hidden page only for what the user should act on", () => {
    expect(anyNeedsUser(["working", "done", null])).toBe(false);
    expect(anyNeedsUser(["working", "failed"])).toBe(true);
    expect(anyNeedsUser(["attention"])).toBe(true);
  });

  it("keeps compact surfaces to requests and failures", () => {
    expect(urgentSignal("attention")).toBe("attention");
    expect(urgentSignal("failed")).toBe("failed");
    expect(urgentSignal("done")).toBeNull();
    expect(urgentSignal("working")).toBeNull();
  });
});

describe("the Recent box", () => {
  const always = () => true;
  it("takes the inbox head across projects, without pinned, settled or working threads", () => {
    const threads = [
      thread("pinned", "a", { pinnedAt: ago(0), latestRun: run(ago(1000)) }),
      thread("settled", "a", { settledOverride: "settled", latestRun: run(ago(2000)) }),
      thread("working", "b", { runtime: { status: "running" }, latestRun: run(null, ago(500)) }),
      thread("old", "b", { latestRun: run(ago(5 * HOUR)) }),
      thread("new", "c", { latestRun: run(ago(HOUR)) }),
    ];
    const recent = selectRecentThreads({
      threads,
      supportsSettlement: always,
      supportsSnooze: always,
      workingShelfEnabled: true,
      returnedAt: undefined,
      now: new Date(NOW).toISOString(),
    });
    expect(recent.map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("stops at five", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread(`t${index}`, "a", { latestRun: run(ago(index * HOUR)) }),
    );
    const recent = selectRecentThreads({
      threads,
      supportsSettlement: always,
      supportsSnooze: always,
      workingShelfEnabled: true,
      returnedAt: undefined,
      now: new Date(NOW).toISOString(),
    });
    expect(recent.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });
});

describe("the home list", () => {
  it("shows the selected project's newest six, settled included", () => {
    const threads = [
      ...Array.from({ length: 7 }, (_, index) =>
        thread(`a${index}`, "a", {
          latestRun: run(ago((index + 1) * HOUR)),
          settledOverride: index === 0 ? "settled" : null,
        }),
      ),
      thread("b0", "b", { latestRun: run(ago(0)) }),
    ];
    const home = selectHomeThreads({ threads, group: group("a") });
    expect(home.map((t) => t.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"]);
    expect(selectHomeThreads({ threads, group: null, limit: 2 }).map((t) => t.id)).toEqual([
      "b0",
      "a0",
    ]);
  });
});

describe("the project window", () => {
  const named = (projectKey: string, displayName: string) => ({ ...group(projectKey), displayName });
  const list = {
    listed: [named("a", "rubato-lab"), named("b", "writing-workbench")],
    quiet: [named("c", "Rubato Docs")],
  };

  it("finds projects by name in both sections, ignoring case", () => {
    const found = filterProjectList(list, "rub");
    expect(found.listed.map((g) => g.projectKey)).toEqual(["a"]);
    expect(found.quiet.map((g) => g.projectKey)).toEqual(["c"]);
    expect(filterProjectList(list, "  ")).toBe(list);
  });

  it("lights the button with the most pressing project, if any", () => {
    expect(strongestUrgentSignal(new Map([["a", "working"], ["b", "done"]]))).toBeNull();
    expect(strongestUrgentSignal(new Map([["a", "failed"], ["b", "attention"]]))).toBe("attention");
  });
});

describe("a new thread while one project is selected", () => {
  const local = { environmentId: "mac", projectId: "p-mac" };
  const remote = { environmentId: "box", projectId: "p-box" };
  const scoped = { environmentId: "mac", id: "p-mac", memberProjectRefs: [remote, local] };

  it("opens in the selected project, not the picker", () => {
    expect(scopedNewThreadProjectRef({ group: scoped, contextProjectRef: null })).toBe(local);
  });

  it("keeps the current thread's copy of that project", () => {
    expect(scopedNewThreadProjectRef({ group: scoped, contextProjectRef: remote })).toBe(remote);
  });

  it("stays on the current thread's machine when that thread is elsewhere", () => {
    const elsewhere = { environmentId: "box", projectId: "other" };
    expect(scopedNewThreadProjectRef({ group: scoped, contextProjectRef: elsewhere })).toBe(remote);
    const otherMachine = { environmentId: "cloud", projectId: "other" };
    expect(scopedNewThreadProjectRef({ group: scoped, contextProjectRef: otherMachine })).toBe(local);
  });

  it("leaves T3's flow alone with no project selected", () => {
    expect(scopedNewThreadProjectRef({ group: null, contextProjectRef: local })).toBeNull();
  });
});
