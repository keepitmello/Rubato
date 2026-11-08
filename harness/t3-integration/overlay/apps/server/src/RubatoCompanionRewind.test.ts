// What the companion room's rewind takes out of the thread (RubatoCompanionRewind.ts), on the two
// shapes a companion thread has: a messenger message written in after the companion's words, inside
// the run those words opened, and a message typed in the app that opened a turn of its own.
import type { OrchestrationV2ConversationMessage, OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { companionRewindPlan } from "./RubatoCompanionRewind.ts";

const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
const run = (id: string, ordinal: number, userMessageId: string, minute: number, status = "completed") =>
  ({ id, threadId: "room", ordinal, status, userMessageId, providerInstanceId: "rubato", requestedAt: at(minute),
    startedAt: at(minute), completedAt: at(minute) }) as unknown as OrchestrationV2Run;
const message = (id: string, role: "user" | "assistant", runId: string | null, minute: number) =>
  ({ id, role, runId, text: id, createdAt: at(minute) }) as unknown as OrchestrationV2ConversationMessage;
/** Each message's own row in the turn, stamped when the message was. */
const itemOf = (entry: OrchestrationV2ConversationMessage) =>
  ({ id: entry.id, runId: entry.runId, messageId: entry.id, type: `${entry.role}_message`, startedAt: entry.createdAt,
    updatedAt: entry.createdAt }) as unknown as OrchestrationV2TurnItem;
const records = (runs: OrchestrationV2Run[], messages: OrchestrationV2ConversationMessage[]) =>
  ({ runs, messages, turnItems: messages.map(itemOf) });

// Roo's room: each reply is a run of its own, and the person's messenger messages sit in the run
// before them.
const roo = records(
  [run("said-1", 1, "said-1", 1), run("said-2", 2, "said-2", 3), run("said-3", 3, "said-3", 5)],
  [
    message("tg-1", "user", null, 0),
    message("said-1", "assistant", "said-1", 1),
    message("tg-2", "user", "said-1", 2),
    message("said-2", "assistant", "said-2", 3),
    message("tg-3", "user", "said-2", 4),
    message("said-3", "assistant", "said-3", 5),
  ],
);

it("drops a messenger message, the rest of its run and every later run", () => {
  const plan = companionRewindPlan(roo, "tg-2");
  if ("refused" in plan) throw new Error(plan.refused.message);
  expect(plan.runs.map((entry) => entry.id)).toEqual(["said-2", "said-3"]);
  expect(plan.cut?.run.id).toBe("said-1");
  expect(plan.cut?.messages.map((entry) => entry.id)).toEqual(["tg-2"]);
  expect(plan.cut?.items.map((entry) => entry.id)).toEqual(["tg-2"]);
});

it("drops the first message on no run with everything after it", () => {
  const plan = companionRewindPlan(roo, "tg-1");
  if ("refused" in plan) throw new Error(plan.refused.message);
  expect(plan.runs.map((entry) => entry.id)).toEqual(["said-1", "said-2", "said-3"]);
  expect(plan.cut?.messages.map((entry) => entry.id)).toEqual(["tg-1"]);
});

// Segno's room: a message typed in the app opens a turn; the companion's words come as runs.
const segno = records(
  [run("turn-1", 1, "app-1", 0), run("said-1", 2, "said-1", 1), run("turn-2", 3, "app-2", 2), run("said-2", 4, "said-2", 3)],
  [
    message("app-1", "user", "turn-1", 0),
    message("said-1", "assistant", "said-1", 1),
    message("app-2", "user", "turn-2", 2),
    message("said-2", "assistant", "said-2", 3),
  ],
);

it("drops the turn a typed message opened, and nothing before it", () => {
  const plan = companionRewindPlan(segno, "app-2");
  if ("refused" in plan) throw new Error(plan.refused.message);
  expect(plan.runs.map((entry) => entry.id)).toEqual(["turn-2", "said-2"]);
  expect(plan.cut).toBeNull();
});

it("refuses while a turn runs, and a message that is not the person's or already gone", () => {
  const running = { ...segno, runs: [...segno.runs.slice(0, 3), run("said-2", 4, "said-2", 3, "running")] };
  expect(companionRewindPlan(running, "app-2")).toEqual({ refused: expect.objectContaining({ code: "busy" }) });
  expect(companionRewindPlan(segno, "said-1")).toEqual({ refused: expect.objectContaining({ code: "not-a-message" }) });
  const rolledBack = { ...segno, runs: [segno.runs[0]!, segno.runs[1]!, run("turn-2", 3, "app-2", 2, "rolled_back")] };
  expect(companionRewindPlan(rolledBack, "app-2")).toEqual({ refused: expect.objectContaining({ code: "not-a-message" }) });
});
