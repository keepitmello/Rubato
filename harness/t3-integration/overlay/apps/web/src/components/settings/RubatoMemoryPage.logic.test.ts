import { describe, expect, it } from "@effect/vitest";

import type { MemoryFileEntry, MemoryStoreSummary, ProjectChanges, UserMemoryView } from "../../state/rubatoMemory";
import type { SegnoAboutLine, SegnoMemoryView } from "../../state/rubatoSegnoMemory";
import {
  changePhrases,
  fallbackTopics,
  filterQuestions,
  insightLanguage,
  listedStores,
  needsYou,
  oldestRef,
  placeCompanionLines,
  projectLine,
  questionTitle,
} from "./RubatoMemoryPage.logic";

const store = (name: string, fields: Partial<MemoryStoreSummary> = {}): MemoryStoreSummary => ({
  store: name,
  repo: `/m/${name}/repo`,
  roots: null,
  home: null,
  files: 3,
  empty: false,
  lastChangeAt: null,
  lastRun: null,
  enabled: true,
  running: null,
  ...fields,
});

const line = (id: string, text: string, kind: "user" | "us" = "user", sent?: string): SegnoAboutLine => ({
  id, text, kind, refs: null, file: `memory/${kind}.md`, updatedAt: "2026-11-07T00:00:00Z", ...(sent ? { sent } : {}),
});

const segno = (fields: Partial<SegnoMemoryView> = {}): SegnoMemoryView => ({
  id: "segno",
  title: "Segno",
  home: "/h/.rubato/companion",
  exists: true,
  status: null,
  questions: {
    path: "memory/to-ask.md",
    updatedAt: null,
    items: [
      { id: "ask-1", text: "Mail keeps failing. New password?", refs: "꿈 10-22~11-07", proposal: false },
      { id: "ask-2", text: "Add a line to my prompt?", refs: "daily 11-03", proposal: true },
      { id: "ask-3", text: "Already answered", refs: null, proposal: false, sent: "2026-11-09T00:00:00Z" },
    ],
  },
  about: [line("user-a", "Dislikes paid API models"), line("user-b", "Hands over logins too"), line("us-c", "Calls me 오빠", "us")],
  records: [],
  weekly: [],
  entities: [],
  dream: null,
  ...fields,
});

const user: Pick<UserMemoryView, "topics"> = {
  topics: [{ id: "constraints", title: "Constraints", items: [{ path: "constraints/approve-paid-runs.md", text: "Ask before paid runs", summarized: true, conclusion: [], scope: [], evidence: [], updatedAt: null }] }],
};

describe("needsYou", () => {
  it("puts open questions first, then overlaps, proposals, failed dreams and empty stores", () => {
    const items = needsYou({
      segno: segno({ dream: { lastRunAt: "2026-11-09T04:07:23+09:00", lastStatus: "failed", reason: "every model failed", attempts: [], blocks: {} } }),
      overlaps: [{ line: "user-a", shared: "constraints/approve-paid-runs.md", relation: "overlap", note: "both about money" }],
      user,
      stores: [store("rubato"), store("segno", { files: 0, empty: true }), store("hash-game", { lastRun: { runId: "r1", status: "failed", reason: "merge failed", attempts: [], landed: false } })],
      dismissed: new Set(),
    });
    expect(items.map((item) => item.kind)).toEqual(["question", "overlap", "proposal", "dream-failed", "dream-failed", "empty-stores"]);
    // A question the person already answered waits for Segno, not for them.
    expect(items.filter((item) => item.kind === "question").map((item) => item.id)).toEqual(["ask-1"]);
    const overlap = items.find((item) => item.kind === "overlap");
    expect(overlap && overlap.kind === "overlap" ? [overlap.line, overlap.shared] : null).toEqual(["Dislikes paid API models", "Ask before paid runs"]);
  });

  it("leaves out what the person put away and overlaps whose lines are gone", () => {
    const items = needsYou({
      segno: segno(),
      overlaps: [{ line: "user-gone", shared: "constraints/approve-paid-runs.md", relation: "same", note: "" }],
      user,
      stores: [store("quiet", { files: 0, empty: true })],
      dismissed: new Set(["ask-1", "empty:quiet"]),
    });
    expect(items.map((item) => item.id)).toEqual(["ask-2"]);
  });
});

describe("a project's week", () => {
  const project: Pick<ProjectChanges, "files"> = {
    files: [
      { path: "decisions/a.md", change: "modified", kind: "decision", title: "App rewind keeps the session" },
      { path: "decisions/b.md", change: "modified", kind: "decision", title: null },
      { path: "decisions/c.md", change: "added", kind: "decision", title: "Why files go through reply" },
      { path: "reference/d.md", change: "deleted", kind: "reference", title: null },
      { path: "notes/why-it-folds.md", change: "added", kind: "other", title: null },
    ],
  };
  it("reads as counts per kind, zeros left out", () => {
    expect(changePhrases(project)).toEqual([
      { phrase: "{0} decisions changed", n: 2 },
      { phrase: "{0} new decisions", n: 1 },
      { phrase: "{0} notes changed", n: 1 },
      { phrase: "{0} removed", n: 1 },
    ]);
  });
  it("falls back to the questions themselves, never a deleted one", () => {
    expect(fallbackTopics(project, 3)).toEqual({ titles: ["App rewind keeps the session", "b", "Why files go through reply"], more: 1 });
  });
  it("uses the summary line only when it was written for this week", () => {
    const ready = { projects: { status: "ready" as const, value: { lines: { rubato: "되감기 · 파일" } } } };
    expect(projectLine(ready, "rubato")).toBe("되감기 · 파일");
    expect(projectLine({ projects: { ...ready.projects, status: "working", stale: true } }, "rubato")).toBeNull();
    expect(projectLine(null, "rubato")).toBeNull();
  });
});

describe("placeCompanionLines", () => {
  it("puts a line that overlaps a shared one right after it, once, and keeps the rest apart", () => {
    const lines = [line("user-a", "a"), line("user-b", "b")];
    const placed = placeCompanionLines(
      lines,
      [
        { line: "user-a", shared: "constraints/approve-paid-runs.md", relation: "overlap", note: "" },
        { line: "user-a", shared: "preferences/other.md", relation: "same", note: "" },
        { line: "user-b", shared: "gone.md", relation: "same", note: "" },
      ],
      new Set(["constraints/approve-paid-runs.md", "preferences/other.md"]),
    );
    expect([...placed.besideShared.entries()].map(([path, entries]) => [path, entries.map((entry) => entry.line.id)])).toEqual([
      ["constraints/approve-paid-runs.md", ["user-a"]],
    ]);
    expect(placed.alone.map((entry) => entry.id)).toEqual(["user-b"]);
  });
});

describe("questions", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const files: MemoryFileEntry[] = [
    { path: "decisions/app-rewind.md", description: "How rewind works", title: "App rewind does not change the session", kind: "decision", changedAt: "2026-11-09T03:00:00Z", writer: "session" },
    { path: "reference/cua.md", description: "Computer use backend", title: null, kind: "reference", changedAt: "2026-10-01T00:00:00Z", writer: "dream" },
    { path: "decisions/old-thing.md", description: null, title: null, kind: "decision", changedAt: null, writer: null },
  ];
  it("filter by kind, by recent change and by words, newest first", () => {
    expect(filterQuestions(files, "all", "", now).map((file) => file.path)).toEqual(["decisions/app-rewind.md", "reference/cua.md", "decisions/old-thing.md"]);
    expect(filterQuestions(files, "decision", "", now).map((file) => file.path)).toEqual(["decisions/app-rewind.md", "decisions/old-thing.md"]);
    expect(filterQuestions(files, "recent", "", now).map((file) => file.path)).toEqual(["decisions/app-rewind.md"]);
    expect(filterQuestions(files, "all", "computer BACKEND", now).map((file) => file.path)).toEqual(["reference/cua.md"]);
  });
  it("read as their question", () => {
    expect(files.map(questionTitle)).toEqual(["App rewind does not change the session", "Computer use backend", "old thing"]);
  });
});

describe("small readings", () => {
  it("asks for summaries in the interface language", () => {
    expect(insightLanguage("ko")).toBe("Korean");
    expect(insightLanguage("en")).toBe("English");
    expect(insightLanguage(null)).toBe("English");
  });
  it("does not list a store that holds nothing", () => {
    expect(listedStores([store("a"), store("b", { files: 0, empty: true })]).map((entry) => entry.store)).toEqual(["a"]);
  });
  it("finds the oldest date a question mentions", () => {
    expect(oldestRef([{ refs: "daily 10-22·10-23" }, { refs: "대화 10-20 07:07" }, { refs: null }])).toBe("10-20");
    expect(oldestRef([{ refs: null }])).toBeNull();
  });
});
