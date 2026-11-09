import { describe, expect, it } from "@effect/vitest";

import { addedContent, chatPrompt, projectForStore } from "./RubatoMemorySettings.logic";

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

