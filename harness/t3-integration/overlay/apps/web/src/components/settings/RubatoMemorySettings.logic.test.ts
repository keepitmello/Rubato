import { describe, expect, it } from "@effect/vitest";

import {
  addedContent,
  chatPrompt,
  fallbackNote,
  lastDreamLine,
  overviewStatus,
  projectForStore,
  runLabel,
  splitQuiet,
} from "./RubatoMemorySettings.logic";

describe("addedContent", () => {
  it("reads a new file out of its diff without the front matter", () => {
    const diff = [
      "diff --git a/decisions/a.md b/decisions/a.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/decisions/a.md",
      "@@ -0,0 +1,5 @@",
      "+---",
      "+description: why a",
      "+---",
      "+",
      "+## 결론",
    ].join("\n");
    expect(addedContent(diff)).toBe("## 결론");
  });
});

describe("runLabel", () => {
  const base = { status: "merged", landed: false } as const;
  it("says what the run did to memory", () => {
    expect(runLabel({ ...base, landed: true }).label).toBe("Changed memory");
    expect(runLabel({ ...base, status: "pending", review: "merged", landed: true }).label).toBe("Changed memory");
    expect(runLabel({ ...base, status: "noop" }).label).toBe("Nothing to change");
    expect(runLabel({ ...base, review: "reverted" }).label).toBe("Undone");
    expect(runLabel({ ...base, status: "failed" }).variant).toBe("error");
  });

  it("reads a run an earlier version left waiting, and never approved, as not applied", () => {
    expect(runLabel({ ...base, status: "pending" }).label).toBe("Not applied");
  });
});

describe("lastDreamLine", () => {
  const ago = () => "2 hours ago";
  const run = { runId: "dream-1", status: "merged", finishedAt: "2026-10-03T00:00:00Z", attempts: [], landed: true } as const;

  it("says the daily dream is off, and when it last ran if it ever did", () => {
    expect(lastDreamLine(false, null, ago).text).toBe("Daily dream off");
    expect(lastDreamLine(false, run, ago).text).toBe("Daily dream off · last ran 2 hours ago");
  });

  it("says how the last run went", () => {
    expect(lastDreamLine(true, null, ago).text).toBe("Daily dream on · has not run yet");
    expect(lastDreamLine(true, run, ago).text).toBe("Last dream 2 hours ago changed memory");
    expect(lastDreamLine(true, { ...run, status: "noop", landed: false }, ago).text).toBe(
      "Last dream 2 hours ago: nothing to change",
    );
    const failed = lastDreamLine(true, { ...run, status: "failed", landed: false, reason: "merge failed: x\nmore" }, ago);
    expect(failed).toEqual({ text: "Last dream 2 hours ago failed: merge failed: x", tone: "error" });
  });
});

describe("fallbackNote", () => {
  it("says nothing when the first model answered", () => {
    expect(fallbackNote([])).toBeNull();
    expect(fallbackNote([{ model: "b-ai/deepseek-v4.1-flash", ok: true }])).toBeNull();
  });

  it("names the models that failed before the one that answered, or that all failed", () => {
    const deepseek = { model: "b-ai/deepseek-v4.1-flash", ok: false, error: "credit insufficient" };
    const grok = { model: "xai/grok-4.7", ok: false, error: "Internal error" };
    expect(fallbackNote([deepseek, grok, { model: "anthropic/claude-haiku-4-5", ok: true }])).toBe(
      "Fell back after b-ai/deepseek-v4.1-flash, xai/grok-4.7 failed",
    );
    expect(fallbackNote([deepseek, grok])).toBe("Every model failed: b-ai/deepseek-v4.1-flash, xai/grok-4.7");
  });
});

describe("projectForStore", () => {
  const projects = [
    { title: "deep", workspaceRoot: "/code/lab/rubato/packages" },
    { title: "inner", workspaceRoot: "/code/lab/rubato" },
    { title: "other", workspaceRoot: "/code/other" },
  ];

  it("takes the project opened at one of the store's folders", () => {
    expect(projectForStore(projects, ["/code/lab", "/code/lab/rubato"])?.title).toBe("inner");
  });

  it("falls back to the shallowest project inside a store folder", () => {
    expect(projectForStore(projects, ["/code/lab"])?.title).toBe("inner");
  });

  it("does not take a folder that only shares a name prefix", () => {
    expect(projectForStore(projects, ["/code/oth"])).toBeNull();
  });

  it("has no project for a store whose folders are unknown", () => {
    expect(projectForStore(projects, null)).toBeNull();
    expect(projectForStore(projects, [])).toBeNull();
  });
});

describe("chatPrompt", () => {
  const store = { store: "rubato", repo: "/m/agents/rubato/repo" };

  it("names the memory and how to change it, and leaves the question to the user", () => {
    const prompt = chatPrompt(store);
    expect(prompt).toContain("`/m/agents/rubato/repo`");
    expect(prompt).toContain("memory tools");
    expect(prompt.endsWith("\n\n")).toBe(true);
  });

  it("names the file or the dream run asked about", () => {
    expect(chatPrompt(store, { file: "decisions/a.md" })).toContain("`decisions/a.md`");
    const run = { runId: "dream-1", sources: { report: "/m/runs/dream-1/out/report.md", range: { base: "abc123", head: "def456" } } };
    const prompt = chatPrompt(store, { run });
    expect(prompt).toContain("/m/runs/dream-1/out/report.md");
    expect(prompt).toContain("git -C /m/agents/rubato/repo diff abc123 def456");
  });
});

describe("overviewStatus", () => {
  const ok = { model: "b-ai/deepseek-v4.1-flash", ok: true };
  const run = (fields: object) => ({ runId: "r", status: "merged", startedAt: "2026-10-01T00:00:00Z", attempts: [ok], landed: true, ...fields });
  const store = (name: string, fields: object = {}) => ({ store: name, files: 10, lastChangeAt: null, enabled: true, lastRun: null, ...fields });

  it("counts notes and dreaming projects and finds the newest dream", () => {
    const status = overviewStatus([
      store("a", { lastRun: run({ runId: "old", startedAt: "2026-09-01T00:00:00Z" }) }),
      store("b", { files: 5, enabled: false, lastRun: run({ runId: "new" }) }),
    ]);
    expect([status.projects, status.notes, status.dreaming]).toEqual([2, 15, 1]);
    expect(status.newest?.store).toBe("b");
    expect(status.attention).toEqual([]);
  });

  it("asks for a look at a dream that failed or had to fall back", () => {
    const deepseek = { model: "b-ai/deepseek-v4.1-flash", ok: false, error: "credit insufficient" };
    const haiku = { model: "anthropic/claude-haiku-4-5", ok: true };
    const status = overviewStatus([
      store("rubato", { lastRun: run({ attempts: [deepseek, haiku] }) }),
      store("home", { lastRun: run({ status: "failed", landed: false, reason: "merge failed: conflict\nmore", attempts: [haiku] }) }),
    ]);
    expect(status.attention).toEqual([
      { store: "rubato", runId: "r", title: "rubato's dream fell back to anthropic/claude-haiku-4-5", detail: "b-ai/deepseek-v4.1-flash: credit insufficient" },
      { store: "home", runId: "r", title: "home's last dream failed", detail: "merge failed: conflict" },
    ]);
  });
});

describe("splitQuiet", () => {
  it("folds projects with no change in three weeks", () => {
    const now = Date.parse("2026-10-04T00:00:00Z");
    const stores = [
      { store: "busy", files: 1, enabled: true, lastRun: null, lastChangeAt: "2026-10-03T00:00:00Z" },
      { store: "old", files: 1, enabled: true, lastRun: null, lastChangeAt: "2026-09-01T00:00:00Z" },
      { store: "empty", files: 0, enabled: true, lastRun: null, lastChangeAt: null },
    ];
    const { active, quiet } = splitQuiet(stores, now);
    expect(active.map((entry) => entry.store)).toEqual(["busy"]);
    expect(quiet.map((entry) => entry.store)).toEqual(["old", "empty"]);
  });
});
