import { describe, expect, it } from "@effect/vitest";

import type { DreamRunDetail } from "../../state/rubatoMemory";
import { addedContent, askPrompt, projectForStore, runLabel } from "./RubatoMemorySettings.logic";

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

describe("askPrompt", () => {
  const detail = {
    store: "rubato",
    runId: "dream-1",
    pending: true,
    landed: false,
    uncommitted: [],
    sources: {
      report: "/m/agents/rubato/runtime/dream/runs/dream-1/out/report.md",
      repo: "/m/agents/rubato/repo",
      range: { base: "abc123", head: "dream/dream-1" },
    },
  } as unknown as DreamRunDetail;

  it("points the agent at the run's report and changes, and leaves the question to the user", () => {
    const prompt = askPrompt(detail);
    expect(prompt).toContain(detail.sources.report);
    expect(prompt).toContain("git -C /m/agents/rubato/repo diff abc123 dream/dream-1");
    expect(prompt.endsWith("\n\n")).toBe(true);
  });

  it("names the file when asked from a file", () => {
    expect(askPrompt(detail, "decisions/a.md")).toContain("decisions/a.md");
  });

  it("names edits nobody committed, since they block the review", () => {
    const blocked = { ...detail, uncommitted: ["reference/x.md"] } as DreamRunDetail;
    expect(askPrompt(blocked)).toContain("`reference/x.md`");
    expect(askPrompt(detail)).not.toContain("nobody committed");
  });
});

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
  const base = { status: "pending", pending: false, landed: false } as const;
  it("says where the edits are now", () => {
    expect(runLabel({ ...base, pending: true }).label).toBe("Needs review");
    expect(runLabel({ ...base, review: "merged", landed: true }).label).toBe("In memory");
    expect(runLabel({ ...base, status: "merged", landed: true }).label).toBe("In memory");
    expect(runLabel({ ...base, review: "reverted" }).label).toBe("Undone");
    expect(runLabel({ ...base, review: "rejected" }).label).toBe("Discarded");
    expect(runLabel({ ...base, status: "failed" }).variant).toBe("error");
  });
});
