import { LOOP_ARGUMENT_HINT, LOOP_COMMAND_DESCRIPTION, completeLoopArguments, intervalToMs, parseLoopArgs } from "./parse.mjs";

export const LOOP_TICK_ENTRY_TYPE = "loop-tick";

export function createNodeTimerPort() {
  const handles = new Map();
  const generations = new Map();
  function cancel(key) {
    const handle = handles.get(key);
    if (handle !== undefined) clearTimeout(handle);
    handles.delete(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }
  return {
    arm(key, dueAt, callback, now = Date.now) {
      cancel(key);
      const generation = generations.get(key) ?? 0;
      const delayMs = Math.max(0, dueAt - now());
      const handle = setTimeout(() => {
        handles.delete(key);
        if (generations.get(key) !== generation) return;
        callback();
      }, delayMs);
      handle.unref?.();
      handles.set(key, handle);
    },
    cancel,
    cancelAll() {
      for (const key of [...handles.keys()]) cancel(key);
    },
  };
}

function mintId(prefix, sequence) {
  return prefix + "-" + Date.now().toString(36) + "-" + sequence.toString(36);
}

export function createLoopExtension(options = {}) {
  const timerPort = options.timerPort ?? createNodeTimerPort();
  const now = options.now ?? Date.now;
  return (pi) => {
    const entries = new Map();
    let sequence = 0;
    let ctxRef;

    function persistTick(entry, delivery) {
      pi.appendEntry(LOOP_TICK_ENTRY_TYPE, {
        loopId: entry.id,
        mode: entry.kind,
        delivery,
        prompt: entry.prompt,
      });
    }

    function dispatch(entry) {
      if (!ctxRef || entry.phase !== "active") return;
      persistTick(entry, ctxRef.isIdle() ? "idle" : "followUp");
      const deliverAs = ctxRef.isIdle() ? undefined : "followUp";
      pi.sendUserMessage(entry.prompt, {
        expandPromptTemplates: true,
        ...(deliverAs ? { deliverAs } : {}),
      });
    }

    function arm(entry) {
      if (entry.kind !== "fixed" || entry.phase !== "active") return;
      const dueAt = now() + entry.intervalMs;
      entry.nextDueAt = dueAt;
      timerPort.arm(entry.id, dueAt, () => {
        dispatch(entry);
        arm(entry);
      }, now);
    }

    function stopEntry(entry, reason) {
      entry.phase = "ended";
      entry.endedReason = reason;
      timerPort.cancel(entry.id);
    }

    function activeEntries() {
      return [...entries.values()].filter((entry) => entry.phase !== "ended");
    }

    function resolveTarget(target) {
      const active = activeEntries();
      if (target.type === "all") return active;
      if (target.type === "id") {
        const found = entries.get(target.id);
        return found && found.phase !== "ended" ? [found] : [];
      }
      return active.length === 1 ? active : [];
    }

    pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
    pi.on("session_shutdown", () => { timerPort.cancelAll(); ctxRef = undefined; });

    pi.registerCommand("loop", {
      description: LOOP_COMMAND_DESCRIPTION,
      argumentHint: LOOP_ARGUMENT_HINT,
      getArgumentCompletions: completeLoopArguments,
      handler: async (rawArgs, ctx) => {
        ctxRef = ctx;
        const parsed = parseLoopArgs(rawArgs);
        if (parsed.kind === "invalid") {
          ctx.ui.notify(parsed.reason + "\n" + parsed.usage, "error");
          return;
        }
        if (parsed.kind === "status") {
          const active = activeEntries();
          if (active.length === 0) {
            ctx.ui.notify("No active loops.", "info");
            return;
          }
          ctx.ui.notify("Active loops:\n" + active.map((entry) => "- " + entry.id + " (" + entry.kind + ")" + (entry.phase === "suspended" ? " · paused" : "")).join("\n"), "info");
          return;
        }
        if (parsed.kind === "stop" || parsed.kind === "pause" || parsed.kind === "resume") {
          const matched = resolveTarget(parsed.target);
          if (matched.length === 0) {
            ctx.ui.notify("No matching loop to " + parsed.kind + ".", "warning");
            return;
          }
          for (const entry of matched) {
            if (parsed.kind === "stop") stopEntry(entry, "stopped");
            else if (parsed.kind === "pause") {
              entry.phase = "suspended";
              timerPort.cancel(entry.id);
            } else {
              entry.phase = "active";
              arm(entry);
            }
          }
          ctx.ui.notify("Loop " + parsed.kind + " " + matched.map((entry) => entry.id).join(", ") + ".", "info");
          return;
        }
        const prompt = parsed.kind === "fixed" || parsed.kind === "dynamic" ? parsed.prompt : "Continue the current task.";
        const interval = parsed.interval ?? { value: 5, unit: "m", raw: "5m" };
        const entry = {
          id: mintId("loop", ++sequence),
          kind: parsed.kind === "dynamic" ? "dynamic" : "fixed",
          phase: "active",
          prompt,
          interval,
          intervalMs: intervalToMs(interval),
        };
        entries.set(entry.id, entry);
        ctx.ui.notify("Loop " + entry.id + " scheduled every " + interval.raw + ". Stop it with `/loop stop " + entry.id + "`. Running the first tick now.", "info");
        dispatch(entry);
        arm(entry);
      },
    });
  };
}

export default createLoopExtension;

