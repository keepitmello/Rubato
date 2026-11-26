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
  openTodoCompletionError,
  openTodoTaskContents,
} from "./todo-nag.mjs";

export { WAKE_SOURCE_STATE_EVENT };
export const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";
export const GOAL_USAGE = "Usage: /goal <objective>";
export const GOAL_EMPTY_HINT = "No goal is currently set.";
// The engine's handle on a goal (pi-server contracts.mjs holds the same names): a companion's
// session_create starts a lead with a goal, a companion's message to a paused or blocked lead
// resumes it, and the follower asks whether the lead will take another turn by itself.
export const GOAL_START_REQUEST = "rubato.goal.start";
export const GOAL_RESUME_REQUEST = "rubato.goal.resume";
export const GOAL_PENDING_REQUEST = "rubato.goal.pending";
/** Automatic goal turns in a row that touched no tool end the goal as blocked: a restated plan is no progress. */
export const GOAL_EMPTY_TURN_LIMIT = 3;
const GOAL_TOOLS = Object.freeze(["update_goal"]);
/** While background work holds a turn back, the goal still looks again this often: work that owes no wake would otherwise silence it. */
export const GOAL_WAIT_RECHECK_MS = 60_000;
/** A continuation whose run has not started by then failed to start. */
export const GOAL_START_TIMEOUT_MS = 60_000;
/** The session-link extension answers this event with how many messages it holds or has handed over and not yet run. */
export const SESSION_HELD_QUERY_EVENT = "rubato.session-link.query-held";

function isWakeSourceStateEvent(data) {
  return Boolean(data) && typeof data === "object" && typeof data.source === "string" && typeof data.activeCount === "number";
}

function toolText(text, details) {
  return { content: [{ type: "text", text }], details };
}

export function createGoalExtension(options = {}) {
  return (pi) => {
    const wakeSources = new Map();
    const awaitedWakes = new Map();
    let started = false;
    let ctxNow; // the session's latest context: the engine's requests carry none
    let queued = false; // a continuation was sent and its run has not started
    let automatic = false; // the run in progress began from a continuation
    let emptyTurns = 0;
    let stopped = false; // the user stopped the work since the last run began
    let run = { tool: false, stopReason: undefined };
    let startTimer; // fires when a queued continuation never started a run
    let recheckTimer; // looks again for a goal held back by background work

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

    // The model finishes a goal with update_goal, so a session that has one needs the tool in its request.
    function activateGoalTools() {
      try { pi.setActiveTools([...new Set([...pi.getActiveTools(), ...GOAL_TOOLS])]); } catch { /* no tool registry yet */ }
    }

    function clearTimers() {
      clearTimeout(startTimer);
      clearTimeout(recheckTimer);
      startTimer = recheckTimer = undefined;
    }

    function queueContinuation(goal, ctx) {
      if (!goal || goal.status !== "active") return;
      queued = true;
      pi.sendMessage({
        customType: GOAL_CONTINUATION_MESSAGE_TYPE,
        content: buildContinuationPrompt(goal),
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
      // sendMessage only registers the turn; if no run starts, the goal must not stay active with nothing coming.
      clearTimeout(startTimer);
      startTimer = setTimeout(async () => {
        startTimer = undefined;
        if (!queued) return;
        queued = false;
        const ref = refFor(ctx);
        if ((await readGoal(ref))?.status === "active")
          await updateGoal(ref, { status: "blocked", reason: "The next turn did not start" }, "user").catch(() => {});
      }, options.startTimeoutMs ?? GOAL_START_TIMEOUT_MS);
      startTimer.unref?.();
    }

    // Another message waiting to run (the companion's, held by session-link) starts the next turn itself and carries the goal on.
    function heldMessages() {
      const query = { count: 0 };
      pi.events?.emit(SESSION_HELD_QUERY_EVENT, query);
      return query.count;
    }

    // Whether the goal takes the next turn now, and the one place that counts a continuation against the cap.
    async function continueGoal(ctx, { waitHolds }) {
      const ref = refFor(ctx);
      const goal = await readGoal(ref);
      if (!goal || goal.status !== "active" || stopped) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages() || heldMessages() > 0) return;
      const awaited = [...awaitedWakes.values()].filter(wait => wait.count > 0 && (wait.until === null || wait.until > Date.now()));
      if (awaited.length > 0) {
        // The completion owns the next turn. A timer must not replace a deliberately quiet
        // wait notification with a goal wake when its watcher exits.
        clearTimeout(recheckTimer);
        recheckTimer = undefined;
        // A command explicitly left in the background may be a server. Its source bounds
        // the completion hold; only that expiry, not each one-minute tick, can reconsider.
        if (awaited.every(wait => wait.until !== null)) {
          const delay = Math.min(2 ** 31 - 1, Math.max(1, Math.max(...awaited.map(wait => wait.until)) - Date.now()));
          recheckTimer = setTimeout(() => { recheckTimer = undefined; void continueGoal(ctx, { waitHolds: false }).catch(() => {}); }, delay);
          recheckTimer.unref?.();
        }
        return;
      }
      if (waitHolds && activeWakeSourceCount() > 0) {
        // A server left running owes no completion; it must not hold the goal indefinitely.
        clearTimeout(recheckTimer);
        recheckTimer = setTimeout(() => { recheckTimer = undefined; void continueGoal(ctx, { waitHolds: false }).catch(() => {}); }, options.recheckMs ?? GOAL_WAIT_RECHECK_MS);
        recheckTimer.unref?.();
        return;
      }
      const recorded = await recordContinuationDelivered(ref, goal.id);
      if (!recorded) {
        if ((await readGoal(ref))?.status === "active")
          await updateGoal(ref, { status: "blocked", reason: "The goal reached its limit of " + GOAL_CONTINUATION_CAP + " automatic continuations" }, "user");
        return;
      }
      try { queueContinuation(recorded, ctx); }
      catch (error) { await updateGoal(ref, { status: "blocked", reason: "The next turn could not be started: " + String(error?.message ?? error).slice(0, 200) }, "user"); }
    }

    pi.events?.on(WAKE_SOURCE_STATE_EVENT, (data) => {
      if (!isWakeSourceStateEvent(data)) return;
      wakeSources.set(data.source, data.activeCount);
      awaitedWakes.set(data.source, {
        count: Number.isFinite(data.awaitedCount) ? Math.max(0, data.awaitedCount) : 0,
        until: Number.isFinite(data.awaitedUntilMs) ? data.awaitedUntilMs : null,
      });
    });

    pi.on("session_start", async (_event, ctx) => {
      if (started) { wakeSources.clear(); awaitedWakes.clear(); }
      else started = true;
      ctxNow = ctx;
      clearTimers();
      queued = automatic = stopped = false;
      emptyTurns = 0;
      run = { tool: false, stopReason: undefined };
      const goal = await readGoal(refFor(ctx));
      if (goal && goal.status !== "complete") activateGoalTools();
      // A goal still active when the session loads takes its next turn, within the same limits as any continuation.
      if (goal?.status === "active") await continueGoal(ctx, { waitHolds: true });
    });
    pi.on("session_shutdown", () => { clearTimers(); });

    pi.on("agent_start", () => {
      automatic = queued;
      queued = false;
      stopped = false;
      clearTimers();
      run = { tool: false, stopReason: undefined };
    });

    // A run can end more than once before it settles (a retry after an error): what counts is
    // whether any of them touched a tool and how the last one stopped.
    // The user's stop can land after the run's last message (during a retry's wait or a compaction), so it is latched where it happens.
    pi.on("session_abort", () => { stopped = true; });

    pi.on("agent_end", (event, ctx) => {
      if (event?.aborted === true || ctx?.signal?.aborted) stopped = true;
      const assistants = (event?.messages ?? []).filter((message) => message?.role === "assistant");
      run = {
        tool: run.tool || assistants.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "toolCall")),
        stopReason: assistants.at(-1)?.stopReason ?? run.stopReason,
        error: assistants.at(-1)?.errorMessage,
      };
    });

    // The run's last boundary, after any retry or compaction: the goal decides here whether the
    // lead takes another turn. Codex's goal does the same when its thread goes idle.
    pi.on("agent_settled", async (_event, ctx) => {
      const ended = run;
      const wasAutomatic = automatic;
      automatic = false;
      run = { tool: false, stopReason: undefined };
      const ref = refFor(ctx);
      const goal = await readGoal(ref);
      if (!goal || goal.status !== "active") return;
      // The user's stop pauses the goal, as Esc does in Codex; a failed turn blocks it, since a
      // goal that keeps retrying a failing provider only spends.
      if (stopped || ended.stopReason === "aborted") { await updateGoal(ref, { status: "paused" }, "user"); return; }
      if (ended.stopReason === "error") {
        await updateGoal(ref, { status: "blocked", reason: "A turn ended with an error: " + String(ended.error ?? "no cause was recorded").slice(0, 300) }, "user");
        return;
      }
      emptyTurns = wasAutomatic && !ended.tool ? emptyTurns + 1 : 0;
      if (emptyTurns >= GOAL_EMPTY_TURN_LIMIT) {
        emptyTurns = 0;
        await updateGoal(ref, { status: "blocked", reason: GOAL_EMPTY_TURN_LIMIT + " goal turns in a row used no tool: nothing changed" }, "user");
        return;
      }
      await continueGoal(ctx, { waitHolds: true });
    });

    pi.rpc?.handle(GOAL_START_REQUEST, async (data) => {
      if (!ctxNow) throw new Error("goal start: the session has not started");
      const ref = refFor(ctxNow);
      const goal = await createGoal(ref, String(data?.objective ?? ""));
      activateGoalTools();
      return { started: true, goalId: goal.id };
    });

    pi.rpc?.handle(GOAL_RESUME_REQUEST, async () => {
      if (!ctxNow) return { resumed: false };
      const ref = refFor(ctxNow);
      const goal = await readGoal(ref);
      if (!goal || !["paused", "blocked"].includes(goal.status)) return { resumed: false };
      await updateGoal(ref, { status: "active" }, "user");
      emptyTurns = 0;
      activateGoalTools();
      return { resumed: true };
    });

    // Whether the goal will start the lead's next turn by itself: the follower holds its "finished"
    // notice to the companion while the goal is active. Every way the goal stops continuing (done,
    // paused, blocked, out of continuations) is a status change, so an active goal always has a next turn coming.
    pi.rpc?.handle(GOAL_PENDING_REQUEST, async () => {
      if (!ctxNow) return { pending: false };
      return { pending: (await readGoal(refFor(ctxNow)))?.status === "active" };
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
              activateGoalTools();
              ctx.ui.notify("Goal " + goalStatusLabel(goal.status) + "\n" + formatGoalForTool(goal, snapshotWakeSources()), "info");
              queueContinuation(goal, ctx);
              return;
            }
            case "setStatus": {
              const goal = await updateGoal(ref, { status: command.status }, "user");
              ctx.ui.notify("Goal " + goalStatusLabel(goal.status) + "\n" + formatGoalForTool(goal, snapshotWakeSources()), "info");
              queueContinuation(goal, ctx);
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
        activateGoalTools();
        queueContinuation(goal, ctx);
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
