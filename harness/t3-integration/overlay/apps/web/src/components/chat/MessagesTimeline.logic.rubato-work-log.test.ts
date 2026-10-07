import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows, liveWorkEntryLabel } from "./MessagesTimeline.logic";

// Rubato's work log (work-log-edits.mjs): phase folds, Codex labels, no thought rows.
const turnId = TurnId.make("turn-1");
const at = (second: number) => new Date(Date.UTC(2026, 9, 8, 0, 0, second)).toISOString();

const phaseContext = (phase: "commentary" | "final_answer") => ({
  version: 1 as const,
  records: [
    { version: 1, contextId: "rubato-phase", kind: "rubato-phase", label: phase, payload: { v: 1, phase } },
  ],
});

const piHex = (name: string) =>
  [...name].map((char) => char.charCodeAt(0).toString(16)).join("").padEnd(24, "0").slice(0, 24);

function message(
  id: string,
  second: number,
  role: ChatMessage["role"],
  text: string,
  phase?: "commentary" | "final_answer",
): TimelineEntry {
  const chat = {
    // Assistant rows carry the Pi id the bridge mints (one Pi message, one row).
    id: MessageId.make(role === "assistant" ? `assistant:pi:session:${piHex(id)}` : id),
    role,
    text,
    turnId: role === "user" ? null : turnId,
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
    ...(phase ? { context: phaseContext(phase) } : {}),
  } as unknown as ChatMessage;
  return { id: `${id}-entry`, kind: "message", createdAt: at(second), message: chat };
}

function work(id: string, second: number, entry: Partial<WorkLogEntry>): TimelineEntry {
  return {
    id: `${id}-entry`,
    kind: "work",
    createdAt: at(second),
    entry: {
      id,
      createdAt: at(second),
      turnId,
      label: "bash",
      toolTitle: "bash",
      tone: "tool",
      itemType: "command_execution",
      toolCallId: `call-${id}`,
      toolLifecycleStatus: "completed",
      ...entry,
    },
  };
}

const rows = (timelineEntries: TimelineEntry[], isWorking = false) =>
  deriveMessagesTimelineRows({
    timelineEntries,
    isWorking,
    activeTurnStartedAt: isWorking ? at(0) : null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    ...(isWorking ? { runningTurnId: turnId } : {}),
  });

describe("rubato work log", () => {
  it("folds commentary with the work and keeps only the final answer in sight", () => {
    const settled = rows([
      message("user", 0, "user", "Fix it"),
      message("note-1", 1, "assistant", "Looking at the bridge.", "commentary"),
      work("read", 2, { rubatoActivity: { kind: "read", target: "src/events.mjs" } }),
      // Commentary right before the answer, with no tool between them, used to stay.
      message("note-2", 3, "assistant", "Found it.", "commentary"),
      message("answer", 4, "assistant", "Fixed.", "final_answer"),
    ]);
    expect(settled.map((row) => row.id)).toEqual(["user-entry", `turn-fold:${turnId}`, "answer-entry"]);
  });

  it("reads an untagged Pi message by whether its tool rows follow it", () => {
    const settled = rows([
      message("user", 0, "user", "Fix it"),
      message("note-1", 1, "assistant", "Looking.", "commentary"),
      work("read", 2, { rubatoActivity: { kind: "read", target: "a.ts" } }),
      message("note-2", 3, "assistant", "Done."),
      // Woken later in the same turn: a note whose tool rows follow it folds.
      message("note-3", 4, "assistant", "One more check."),
      work("test", 5, { rubatoActivity: { kind: "command", target: "npm test" } }),
    ]);
    expect(settled.map((row) => row.id)).toEqual(["user-entry", `turn-fold:${turnId}`, "note-2-entry"]);
  });

  it("keeps a last word that no tool followed, such as commentary cut short", () => {
    const settled = rows([
      message("user", 0, "user", "Fix it"),
      message("note-1", 1, "assistant", "Looking.", "commentary"),
      work("read", 2, { rubatoActivity: { kind: "read", target: "a.ts" } }),
      message("note-2", 3, "assistant", "About to run the tests.", "commentary"),
    ]);
    expect(settled.map((row) => row.id)).toEqual(["user-entry", `turn-fold:${turnId}`, "note-2-entry"]);
  });

  it("shows no thought row once the thinking is done", () => {
    const settled = rows([
      message("user", 0, "user", "Why?"),
      message("reasoning:raw:pi:s:0123456789abcdef01234567:reasoning", 1, "reasoning", "Considering."),
      message("answer", 2, "assistant", "Because.", "final_answer"),
    ]);
    expect(settled.map((row) => row.kind)).toEqual(["message", "message"]);
    expect(settled.map((row) => row.id)).toEqual(["user-entry", "answer-entry"]);
  });

  it("names a finished call, not the thinking after it, on another provider's live line", () => {
    const live = rows(
      [message("user", 0, "user", "Go"), work("lint", 1, { command: "pnpm lint" })],
      true,
    );
    const row = live.find((candidate) => candidate.kind === "work-live");
    expect(row?.kind === "work-live" && row.active).toBe(true);
    expect(row?.kind === "work-live" && row.entry.rubatoActivity).toBeUndefined();
  });

  it("summarizes a finished group in Codex's words and names a lone call by what it did", () => {
    const running = rows(
      [
        message("user", 0, "user", "Go"),
        work("read", 1, { rubatoActivity: { kind: "read", target: "a.ts" } }),
        work("rg", 2, { rubatoActivity: { kind: "search", target: "foo" } }),
        work("test", 3, { rubatoActivity: { kind: "command", target: "npm test" }, command: "npm test" }),
        message("note", 4, "assistant", "Tests pass.", "commentary"),
        work("diff", 5, { rubatoActivity: { kind: "command", target: "git diff" }, command: "git diff" }),
        message("note-2", 6, "assistant", "Reviewing.", "commentary"),
      ],
      true,
    );
    const toggle = running.find((row) => row.kind === "work-toggle");
    expect(toggle?.kind === "work-toggle" && toggle.summary).toBe("Read files and ran a command");
    const single = running.find((row) => row.kind === "work" && row.id === "diff-entry");
    expect(single?.kind === "work" && single.displayLabel).toBe("Ran git diff");
  });

  it("names the running call on the live line", () => {
    const live = rows(
      [
        message("user", 0, "user", "Go"),
        work("test", 1, {
          rubatoActivity: { kind: "command", target: "npm test" },
          command: "npm test",
          toolLifecycleStatus: "inProgress",
        }),
      ],
      true,
    );
    const row = live.find((candidate) => candidate.kind === "work-live");
    expect(row?.kind === "work-live" && liveWorkEntryLabel(row.entry, "/repo", row.active)).toBe(
      "Running npm test",
    );
    const read = live.find((candidate) => candidate.kind === "work-live");
    expect(
      read?.kind === "work-live" &&
        liveWorkEntryLabel(
          { ...read.entry, rubatoActivity: { kind: "read", target: "/repo/src/a.ts" } },
          "/repo",
          true,
        ),
    ).toBe("Reading src/a.ts");
  });

  it("shows a wait the agent ended its run on as the live line, not Thinking", () => {
    const waiting = rows(
      [
        message("user", 0, "user", "Go"),
        message("note", 1, "assistant", "Started the build; I'll pick up when it ends.", "commentary"),
        work("wait", 2, {
          label: "Waiting on background work",
          toolTitle: "Waiting on background work",
          itemType: "dynamic_tool_call",
          toolLifecycleStatus: "inProgress",
          rubatoActivity: { kind: "wait", target: "cargo build" },
        }),
      ],
      true,
    );
    expect(waiting.some((row) => row.kind === "thinking")).toBe(false);
    const row = waiting.find((candidate) => candidate.kind === "work-live");
    expect(row?.kind === "work-live" && row.active).toBe(true);
    expect(row?.kind === "work-live" && liveWorkEntryLabel(row.entry, "/repo", row.active)).toBe(
      "Waiting on cargo build",
    );
  });
});
