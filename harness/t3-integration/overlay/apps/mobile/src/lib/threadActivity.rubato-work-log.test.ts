import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { buildThreadFeed, deriveThreadFeedPresentation, workEntryRowLabel } from "./threadActivity";

// Rubato's work log on the phone (work-log-edits.mjs): the same Pi answer rule as web.
const turnId = TurnId.make("turn-1");
const at = (second: number) => new Date(Date.UTC(2026, 9, 8, 0, 0, second)).toISOString();
const piId = (n: number) => `pi:session:${String(n).padStart(24, "0")}`;

const phaseContext = (phase: "commentary" | "final_answer") => ({
  version: 1 as const,
  records: [
    { version: 1, contextId: "rubato-phase", kind: "rubato-phase", label: phase, payload: { v: 1, phase } },
  ],
});

function assistant(n: number, second: number, text: string, phase?: "commentary" | "final_answer") {
  return {
    id: MessageId.make(`assistant:${piId(n)}`),
    role: "assistant" as const,
    text,
    turnId,
    streaming: false,
    createdAt: at(second),
    updatedAt: at(second),
    ...(phase ? { context: phaseContext(phase) } : {}),
  };
}

function bash(n: number, second: number, command: string) {
  return {
    id: EventId.make(`tool-${n}`),
    kind: "tool.completed" as const,
    tone: "tool" as const,
    summary: "bash",
    createdAt: at(second),
    turnId,
    payload: {
      title: "bash",
      itemType: "command_execution",
      status: "completed",
      toolCallId: `pi-tool:session:call-${n}`,
      data: { command, rubatoActivity: { kind: "command", target: command } },
    },
  };
}

function thread(messages: unknown[], activities: unknown[]): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Pi turn",
    modelSelection: { instanceId: ProviderInstanceId.make("rubato"), model: "claude" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: at(30),
      assistantMessageId: null,
    },
    createdAt: at(0),
    updatedAt: at(30),
    archivedAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
    settledOverride: null,
    settledAt: null,
  } as unknown as OrchestrationThread;
}

const ids = (value: OrchestrationThread) =>
  deriveThreadFeedPresentation(buildThreadFeed(value), value.latestTurn, new Set()).map((entry) => entry.id);

describe("rubato work log on the phone", () => {
  it("folds commentary with the work and keeps only the final answer", () => {
    expect(
      ids(
        thread(
          [
            assistant(1, 1, "Looking.", "commentary"),
            assistant(2, 3, "Found it.", "commentary"),
            assistant(3, 4, "Fixed.", "final_answer"),
          ],
          [bash(1, 2, "rg foo")],
        ),
      ),
    ).toEqual(["turn-fold:turn-1", `assistant:${piId(3)}`]);
  });

  it("reads an untagged Pi message by whether its tool rows follow it", () => {
    expect(
      ids(
        thread(
          [assistant(1, 1, "Looking."), assistant(2, 3, "Woken, done."), assistant(3, 5, "More.")],
          [bash(1, 2, "rg foo"), bash(2, 6, "npm test")],
        ),
      ),
    ).toEqual(["turn-fold:turn-1", `assistant:${piId(2)}`]);
  });

  it("keeps an answer in sight when the agent only saved notes after writing it", () => {
    const notes = {
      id: EventId.make("tool-notes"),
      kind: "tool.completed" as const,
      tone: "tool" as const,
      summary: "notes_append_to_file",
      createdAt: at(4),
      turnId,
      payload: {
        title: "notes_append_to_file",
        itemType: "dynamic_tool_call",
        status: "completed",
        toolCallId: "pi-tool:session:call-notes",
        data: { rubatoActivity: { kind: "other", bookkeeping: true } },
      },
    };
    expect(
      ids(
        thread(
          [
            assistant(1, 1, "Checking.", "commentary"),
            assistant(2, 3, "Long answer.", "commentary"),
            assistant(3, 5, "Send the rest.", "final_answer"),
          ],
          [bash(1, 2, "rg foo"), notes],
        ),
      ),
    ).toEqual(["turn-fold:turn-1", `assistant:${piId(2)}`, `assistant:${piId(3)}`]);
  });

  it("names a tagged call the way web does, keeping a command row's command", () => {
    const entry = {
      id: "e",
      createdAt: at(1),
      turnId,
      label: "read",
      tone: "tool" as const,
      toolLifecycleStatus: "completed" as const,
      rubatoActivity: { kind: "read" as const, target: "/repo/src/a.ts" },
    };
    expect(workEntryRowLabel(entry)).toBe("Read src/a.ts");
    expect(
      workEntryRowLabel({ ...entry, command: "npm test", rubatoActivity: { kind: "command", target: "npm test" } }),
    ).toBe("npm test");
  });
});
