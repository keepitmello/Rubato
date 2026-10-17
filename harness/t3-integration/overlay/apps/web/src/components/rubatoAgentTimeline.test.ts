import { describe, expect, it } from "vite-plus/test";

import { withWriting, type AgentTranscriptItem } from "../state/rubatoAgents";
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
    latestRun: timeline.latestRun,
    runningRunId: timeline.runningRunId,
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
      "work",
      "assistant: Reading the draft.",
      "work-live",
    ]);
  });

  // The Pi adapter's shapes for the lead's own calls: bash is a command, other tools a
  // tool call, thoughts a reasoning row.
  it("tool rows take the item type the lead's calls get", () => {
    const { entries } = agentTimeline(SETTLED, { taskId: "st_a", live: false });
    const work = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
    expect(work.map((entry) => [entry.label, entry.itemType, entry.toolLifecycleStatus])).toEqual([
      ["Thinking", "reasoning", "completed"],
      ["read", "dynamic_tool", "completed"],
      ["bash", "command_execution", "completed"],
      ["Thinking", "reasoning", "completed"],
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

  it("the message an agent is still writing streams after its file, and its finished copy takes its place", () => {
    const writing: AgentTranscriptItem[] = [
      { kind: "thinking", text: "Q2 next", message: 0, at: t0 + 2_000, writing: true },
      { kind: "assistant", text: "Q2 reads fine, but", message: 0, at: t0 + 2_000, writing: true },
    ];
    const items = withWriting(WORKING, writing);
    // Numbered after the file's last message, as the file will number it.
    expect(items.slice(-2).map((item) => ("message" in item ? item.message : null))).toEqual([1, 1]);
    const { entries } = agentTimeline(items, { taskId: "st_a", live: true });
    const said = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
    expect(said.at(-1)).toMatchObject({ text: "Q2 reads fine, but", streaming: true });
    const landed = withWriting(
      [...WORKING, ...writing.map((item) => ({ ...item, message: 1, writing: false }))],
      undefined,
    );
    const after = agentTimeline(landed, { taskId: "st_a", live: true }).entries.flatMap((entry) =>
      entry.kind === "message" ? [entry.message] : [],
    );
    expect(after.at(-1)).toMatchObject({ id: said.at(-1)?.id, streaming: false });
  });

  it("nothing being written leaves the file's items as they are", () => {
    expect(withWriting(WORKING, undefined)).toBe(WORKING);
    expect(withWriting(WORKING, [])).toBe(WORKING);
  });
});
