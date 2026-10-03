import { describe, expect, it } from "vite-plus/test";

import type { AgentTranscriptItem } from "../state/rubatoAgents";
import { deriveMessagesTimelineRows } from "./chat/MessagesTimeline.logic";
import { agentTimeline } from "./rubatoAgentTimeline";

const t0 = Date.parse("2026-10-03T00:00:00Z");
const tool = (id: string, name: string, itemType: "dynamic_tool_call" | "command_execution") =>
  ({
    kind: "tool",
    id,
    name,
    itemType,
    title: name,
    input: "{}",
    message: 0,
    at: t0 + 1_000,
  }) as const;

const WORKING: AgentTranscriptItem[] = [
  { kind: "user", text: "Review Q1", at: t0 },
  { kind: "thinking", text: "Start with the form", message: 0, at: t0 + 1_000 },
  { kind: "assistant", text: "Reading the draft.", message: 0, at: t0 + 1_000 },
  { ...tool("a", "read", "dynamic_tool_call"), output: "# Draft" },
  tool("b", "bash", "command_execution"),
];
const SETTLED: AgentTranscriptItem[] = [
  ...WORKING.slice(0, 4),
  { ...tool("b", "bash", "command_execution"), output: "ok" },
  { kind: "thinking", text: "Enough", message: 1, at: t0 + 65_000 },
  { kind: "assistant", text: "Three stuck sentences.", message: 1, at: t0 + 65_000 },
];

/** The rows the thread's own timeline draws for this conversation. */
function rows(items: AgentTranscriptItem[], live: boolean) {
  const timeline = agentTimeline(items, { taskId: "st_a", live });
  return deriveMessagesTimelineRows({
    timelineEntries: timeline.entries,
    latestTurn: timeline.latestTurn,
    runningTurnId: timeline.runningTurnId,
    isWorking: live,
    activeTurnStartedAt: timeline.activeTurnStartedAt,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
}

const shape = (row: ReturnType<typeof rows>[number]) =>
  row.kind === "message" ? `${row.message.role}: ${row.message.text}` : row.kind;

describe("agentTimeline", () => {
  it("a finished agent folds its work behind one row, as a settled turn of the thread does", () => {
    const settled = rows(SETTLED, false);
    expect(settled.map(shape)).toEqual([
      "user: Review Q1",
      "turn-fold",
      "assistant: Three stuck sentences.",
    ]);
    const fold = settled[1];
    expect(fold?.kind === "turn-fold" && fold.label).toBe("Worked for 1m 5s");
  });

  it("a working agent shows its thoughts and tool calls as folded activity rows", () => {
    expect(rows(WORKING, true).map(shape)).toEqual([
      "user: Review Q1",
      "working",
      "activity-group",
      "assistant: Reading the draft.",
      "work-live",
    ]);
  });

  it("tool rows carry the item type and title the bridge gives the lead's calls", () => {
    const { entries } = agentTimeline(SETTLED, { taskId: "st_a", live: false });
    const work = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
    expect(work.map((entry) => [entry.label, entry.itemType, entry.toolLifecycleStatus])).toEqual([
      ["read", "dynamic_tool_call", "completed"],
      ["bash", "command_execution", "completed"],
    ]);
  });

  it("each message the agent is sent starts a turn; earlier turns stay folded while it works", () => {
    const followUp: AgentTranscriptItem[] = [
      ...SETTLED,
      { kind: "user", text: "Skip Q3", at: t0 + 70_000 },
      { ...tool("c", "read", "dynamic_tool_call"), message: 2, at: t0 + 71_000 },
    ];
    expect(rows(followUp, true).map(shape)).toEqual([
      "user: Review Q1",
      "turn-fold",
      "assistant: Three stuck sentences.",
      "user: Skip Q3",
      "working",
      "work-live",
    ]);
  });
});
