import { describe, expect, it } from "vite-plus/test";

import { summarizeToolGroup, toolGroupAction, type WorkLogPresentationEntry } from "./presentation.ts";
import {
  rubatoActivityLabel,
  rubatoActivityOf,
  rubatoPhaseOf,
  rubatoPiAnswers,
  type RubatoActivity,
  type RubatoAnswerItem,
} from "./rubatoActivity.ts";

const tool = (rubatoActivity: RubatoActivity): WorkLogPresentationEntry => ({
  label: "tool",
  tone: "tool",
  itemType: "dynamic_tool_call",
  rubatoActivity,
});

describe("rubato work log activity", () => {
  it("reads the bridge's tag and drops anything it does not know", () => {
    expect(rubatoActivityOf({ rubatoActivity: { kind: "read", target: " a.ts " } })).toEqual({
      kind: "read",
      target: "a.ts",
    });
    expect(
      rubatoActivityOf({ rubatoActivity: { kind: "edit", target: "a.ts", count: 3 } }),
    ).toEqual({ kind: "edit", target: "a.ts", count: 3 });
    expect(rubatoActivityOf({ rubatoActivity: { kind: "launch" } })).toBeUndefined();
    expect(rubatoActivityOf({ rubatoActivity: { kind: "other", bookkeeping: true } })).toEqual({
      kind: "other",
      bookkeeping: true,
    });
    expect(rubatoActivityOf({})).toBeUndefined();
    expect(rubatoActivityOf(null)).toBeUndefined();
  });

  it("names a running call in the present and a finished one in the past", () => {
    const read: RubatoActivity = { kind: "read", target: "/repo/src/a.ts" };
    const short = (path: string) => path.replace("/repo/", "");
    expect(rubatoActivityLabel(read, "inProgress", short)).toBe("Reading src/a.ts");
    expect(rubatoActivityLabel(read, "completed", short)).toBe("Read src/a.ts");
    expect(rubatoActivityLabel({ kind: "search", target: "foo", path: "src" }, "inProgress")).toBe(
      "Searching for foo in src",
    );
    expect(rubatoActivityLabel({ kind: "list", target: "src" }, "completed")).toBe(
      "Listed files in src",
    );
    expect(rubatoActivityLabel({ kind: "command", target: "npm\n  test" }, "inProgress")).toBe(
      "Running npm test",
    );
    expect(rubatoActivityLabel({ kind: "command", target: "npm test" }, "stopped")).toBe(
      "Stopped npm test",
    );
    expect(rubatoActivityLabel({ kind: "edit", target: "a.ts", count: 2 }, "inProgress")).toBe(
      "Editing files",
    );
    expect(rubatoActivityLabel({ kind: "web", target: "effect schema" }, "completed")).toBe(
      "Searched the web for effect schema",
    );
    expect(rubatoActivityLabel({ kind: "other" }, "inProgress")).toBeUndefined();
    expect(rubatoActivityLabel({ kind: "wait", target: "the test run" }, "inProgress")).toBe(
      "Waiting on the test run",
    );
    expect(rubatoActivityLabel({ kind: "wait" }, "completed")).toBe("Waited on background work");
  });

  it("groups reading, searching and listing as exploration", () => {
    expect(toolGroupAction(tool({ kind: "read" }))).toBe("read");
    expect(toolGroupAction(tool({ kind: "search" }))).toBe("read");
    expect(toolGroupAction(tool({ kind: "list" }))).toBe("read");
    expect(toolGroupAction(tool({ kind: "command" }))).toBe("command");
    expect(toolGroupAction(tool({ kind: "edit" }))).toBe("edit");
    expect(toolGroupAction(tool({ kind: "web" }))).toBe("search");
    expect(toolGroupAction(tool({ kind: "other" }))).toBe("other");
  });

  it("summarizes a finished group in Codex's words and order, without counts", () => {
    expect(
      summarizeToolGroup([
        tool({ kind: "command", target: "npm test" }),
        tool({ kind: "read", target: "a.ts" }),
        tool({ kind: "search", target: "foo" }),
        tool({ kind: "edit", target: "a.ts" }),
        tool({ kind: "command", target: "git diff" }),
      ]),
    ).toBe("Edited a file, read files, and ran commands");
    expect(summarizeToolGroup([tool({ kind: "read" }), tool({ kind: "list" })])).toBe("Read files");
    expect(summarizeToolGroup([tool({ kind: "other" }), tool({ kind: "command" })])).toBe(
      "Called a tool and ran a command",
    );
  });

  it("reads an assistant message's phase from its context record", () => {
    const withPhase = (phase: string) => ({
      context: {
        version: 1,
        records: [
          { version: 1, contextId: "rubato-phase", kind: "rubato-phase", label: "x", payload: { v: 1, phase } },
        ],
      },
    });
    expect(rubatoPhaseOf(withPhase("commentary"))).toBe("commentary");
    expect(rubatoPhaseOf(withPhase("final_answer"))).toBe("final_answer");
    expect(rubatoPhaseOf(withPhase("other"))).toBeUndefined();
    expect(rubatoPhaseOf({})).toBeUndefined();
  });

  it("keeps an answer in sight when only bookkeeping followed it", () => {
    const answer = (n: number, phase: "commentary" | "final_answer"): RubatoAnswerItem => ({
      id: `a${n}`,
      kind: "answer",
      messageId: `assistant:pi:session:${String(n).padStart(24, "0")}`,
      phase,
    });
    const work: RubatoAnswerItem = { id: "work", kind: "tool" };
    const notes: RubatoAnswerItem = { id: "notes", kind: "tool", bookkeeping: true };
    // The answer, then a notes save in the same message, then a closing line.
    expect(
      rubatoPiAnswers([answer(1, "commentary"), work, answer(2, "commentary"), notes, answer(3, "final_answer")])
        .visible,
    ).toEqual(new Set(["a2", "a3"]));
    // Ticking the task list mid-turn is still commentary when work comes after it.
    expect(
      rubatoPiAnswers([answer(1, "commentary"), notes, work, answer(2, "final_answer")]).visible,
    ).toEqual(new Set(["a2"]));
  });
});
