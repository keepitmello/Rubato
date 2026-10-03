import { describe, expect, it } from "@effect/vitest";

import { addedContent, lastDreamLine, runLabel } from "./RubatoMemorySettings.logic";

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
  const run = { runId: "dream-1", status: "merged", finishedAt: "2026-10-03T00:00:00Z", landed: true } as const;

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
