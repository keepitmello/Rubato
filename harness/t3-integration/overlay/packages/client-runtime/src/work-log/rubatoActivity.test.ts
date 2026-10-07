import { describe, expect, it } from "vite-plus/test";

import { summarizeToolGroup, toolGroupAction, type WorkLogPresentationEntry } from "./presentation.ts";
import {
  rubatoActivityLabel,
  rubatoActivityOf,
  rubatoPhaseOf,
  type RubatoActivity,
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
});
