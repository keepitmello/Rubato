import { replaceOnce } from "./core-replace.mjs";

export const isGoalIndexUrl = (url) => url.endsWith("/dist/core/extensions/builtin/goal/index.js");

// Ordinary todo work is not authorization to create a durable goal. Remove the
// unsolicited reminder at its event source; goal tools and completion gates stay intact.
export function injectGoalReminderRemoval(source) {
  let next = replaceOnce(source,
    'import { staleGoalTodoReminder, todoResultAddsOpenTasks } from "./todo-gate.js";\n',
    "", "goal reminder import");
  next = replaceOnce(next, "    let staleGoalReminderSentThisTurn = false;\n", "", "goal reminder state");
  next = replaceOnce(next,
    '    pi.on("turn_start", async () => {\n        staleGoalReminderSentThisTurn = false;\n    });\n',
    "", "goal reminder reset");
  const block = next.match(/    \/\/ When the model starts tracking new open todo work[\s\S]*?(?=    pi\.on\("agent_start")/)?.[0];
  if (!block || !block.includes('pi.on("tool_result"') || !block.includes("staleGoalTodoReminder")) {
    throw new Error("rubato goal reminder hook drift");
  }
  return replaceOnce(next, block, "", "goal reminder hook");
}
