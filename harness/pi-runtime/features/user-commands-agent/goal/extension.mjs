import { Type } from "typebox";
import { WAKE_SOURCE_STATE_EVENT } from "../../codemode/src/extension/wake-source-state.ts";
import { parseGoalCommand } from "./command.mjs";
import { formatGoalForTool, goalStatusLabel } from "./format.mjs";
import { buildContinuationPrompt } from "./prompt.mjs";
import {
  GOAL_CONTINUATION_CAP,
  MODEL_SETTABLE_GOAL_STATUS_VALUES,
  clearGoal,
  createGoal,
  goalStoreRef as buildGoalStoreRef,
  readGoal,
  recordContinuationDelivered,
  updateGoal,
} from "./store.mjs";
import {
  DEFAULT_TODO_NAG_TEXT,
  openTodoCompletionError,
  openTodoTaskContents,
  staleGoalTodoReminder,
  todoResultAddsOpenTasks,
} from "./todo-nag.mjs";

export { WAKE_SOURCE_STATE_EVENT };
export const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";
export const GOAL_USAGE = "Usage: /goal <objective>";
export const GOAL_EMPTY_HINT = "No goal is currently set.";

function isWakeSourceStateEvent(data) {
  return Boolean(data) && typeof data === "object" && typeof data.source === "string" && typeof data.activeCount === "number";
}

function resolveTodoNag(options = {}, env = process.env) {
  if (typeof options.todoNag === "boolean") return options.todoNag;
  if (typeof options.todoNagText === "string") return true;
  const raw = env.RUBATO_GOAL_TODO_NAG;
  if (raw === "0" || raw === "false") return false;
  return true;
}

function toolText(text, details) {
  return { content: [{ type: "text", text }], details };
}

export function createGoalExtension(options = {}) {
  const env = options.env ?? process.env;
  const todoNagEnabled = resolveTodoNag(options, env);
  const todoNagText = options.todoNagText ?? DEFAULT_TODO_NAG_TEXT;
  return (pi) => {
    const wakeSources = new Map();
    let started = false;
    let continuationPending = false;
    let staleGoalReminderSentThisTurn = false;

    function snapshotWakeSources() {
      return Object.fromEntries(wakeSources);
    }

    function activeWakeSourceCount() {
      let total = 0;
      for (const count of wakeSources.values()) total += count;
      return total;
    }

    function refFor(ctx) {
      return buildGoalStoreRef(ctx.sessionManager, options.agentDir);
    }

    function queueContinuation(goal) {
      if (!goal || goal.status !== "active") return;
      if ((goal.consecutiveContinuations ?? 0) >= GOAL_CONTINUATION_CAP) return;
      if (activeWakeSourceCount() > 0) return;
      continuationPending = true;
      pi.sendMessage({
        customType: GOAL_CONTINUATION_MESSAGE_TYPE,
        content: buildContinuationPrompt(goal),
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    }

    pi.events?.on(WAKE_SOURCE_STATE_EVENT, (data) => {
      if (!isWakeSourceStateEvent(data)) return;
      wakeSources.set(data.source, data.activeCount);
    });

    pi.on("session_start", async (_event, ctx) => {
      if (started) wakeSources.clear();
      else started = true;
      continuationPending = false;
      const goal = await readGoal(refFor(ctx));
      if (goal?.status === "active" && activeWakeSourceCount() === 0) queueContinuation(goal);
    });

    pi.on("turn_start", () => { staleGoalReminderSentThisTurn = false; });

    pi.on("tool_result", async (event, ctx) => {
      if (!todoNagEnabled || event.toolName !== "todo" || event.isError || staleGoalReminderSentThisTurn) return;
      if (!todoResultAddsOpenTasks(event.details)) return;
      const reminder = staleGoalTodoReminder(await readGoal(refFor(ctx)), todoNagText);
      if (reminder === undefined) return;
      staleGoalReminderSentThisTurn = true;
      return { content: [...event.content, { type: "text", text: reminder }] };
    });

    pi.on("agent_end", async (_event, ctx) => {
      const pending = continuationPending;
      continuationPending = false;
      if (pending) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      const goal = await readGoal(refFor(ctx));
      if (!goal || goal.status !== "active") return;
      const recorded = await recordContinuationDelivered(refFor(ctx), goal.id);
      if (recorded) queueContinuation(recorded);
    });

    pi.registerCommand("goal", {
      description: "Set, inspect, pause, resume, or clear the persistent goal",
      argumentHint: "<objective | pause | resume | clear>",
      handler: async (rawArgs, ctx) => {
        const command = parseGoalCommand(rawArgs);
        const ref = refFor(ctx);
        try {
          switch (command.kind) {
            case "show": {
              const goal = await readGoal(ref);
              ctx.ui.notify(goal === null ? GOAL_USAGE + "\n" + GOAL_EMPTY_HINT : formatGoalForTool(goal, snapshotWakeSources()), goal ? "info" : "warning");
              return;
            }
            case "setObjective": {
              const current = await readGoal(ref);
              const goal = current === null
                ? await createGoal(ref, command.objective)
                : await updateGoal(ref, { objective: command.objective }, "user");
              ctx.ui.notify("Goal " + goalStatusLabel(goal.status) + "\n" + formatGoalForTool(goal, snapshotWakeSources()), "info");
              queueContinuation(goal);
              return;
            }
            case "setStatus": {
              const goal = await updateGoal(ref, { status: command.status }, "user");
              ctx.ui.notify("Goal " + goalStatusLabel(goal.status) + "\n" + formatGoalForTool(goal, snapshotWakeSources()), "info");
              queueContinuation(goal);
              return;
            }
            case "clear": {
              const cleared = await clearGoal(ref);
              ctx.ui.notify(cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.", cleared ? "info" : "warning");
              return;
            }
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerTool({
      name: "create_goal",
      label: "Create Goal",
      description: "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
      parameters: Type.Object({
        objective: Type.String({ description: "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete." }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const goal = await createGoal(refFor(ctx), params.objective);
        queueContinuation(goal);
        return toolText(JSON.stringify({ goal }, null, 2), { goal });
      },
    });

    pi.registerTool({
      name: "update_goal",
      label: "Update Goal",
      description: "Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective has actually been achieved and no required work remains. Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns.",
      parameters: Type.Object({
        status: Type.Union(MODEL_SETTABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status))),
        reason: Type.Optional(Type.String({ description: "Required and non-empty when status is blocked; rejected when status is complete." })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
        if (params.status === "blocked" && !reason) throw new Error("reason is required when status is blocked");
        if (params.status === "complete" && reason) throw new Error("reason must not be provided when status is complete");
        if (params.status === "complete") {
          const openTasks = openTodoTaskContents(ctx.sessionManager.getBranch());
          if (openTasks.length > 0) throw new Error(openTodoCompletionError(openTasks));
        }
        const goal = await updateGoal(refFor(ctx), { status: params.status, reason }, "model");
        return toolText(JSON.stringify({ goal }, null, 2), { goal });
      },
    });
  };
}

export default createGoalExtension;
