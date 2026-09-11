const MAX_LISTED_TASKS = 5;
const INCOMPLETE = new Set(["pending", "in_progress"]);

function tasksFromDetails(details) {
  if (!details || typeof details !== "object") return [];
  const phases = details.phases;
  if (!Array.isArray(phases)) return [];
  return phases.flatMap((phase) => Array.isArray(phase?.tasks) ? phase.tasks : []);
}

export function todoResultAddsOpenTasks(details) {
  const op = details?.op;
  if (op !== "init" && op !== "append") return false;
  return tasksFromDetails(details).some((task) => INCOMPLETE.has(task?.status));
}

export function openTodoTaskContents(entries) {
  for (let index = (entries ?? []).length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === "senpi.todo-state") {
      const phases = entry.data?.phases;
      if (!Array.isArray(phases)) return [];
      return phases.flatMap((phase) => phase?.tasks ?? [])
        .filter((task) => INCOMPLETE.has(task?.status))
        .map((task) => task.content)
        .filter(Boolean);
    }
  }
  return [];
}

export function openTodoCompletionError(openTasks) {
  const listed = openTasks.slice(0, MAX_LISTED_TASKS).map((task) => '"' + task + '"').join(", ");
  const suffix = openTasks.length > MAX_LISTED_TASKS ? " and " + (openTasks.length - MAX_LISTED_TASKS) + " more" : "";
  return "cannot mark the goal complete: " + openTasks.length + " open todo task(s) remain: " + listed + suffix + ". Finish each task and mark it done, or drop tasks that are genuinely no longer needed, then run the completion audit again and retry update_goal.";
}

export const DEFAULT_TODO_NAG_TEXT = [
  "<system-reminder>",
  "New todo tasks were added, but this thread has no live goal registered.",
  "If this todo list tracks a durable objective (multi-step work that should survive across turns), register it now with create_goal so progress is tracked and audited.",
  "If the todos are trivial short-lived bookkeeping for the current turn, continue without a goal.",
  "</system-reminder>",
].join("\n");

export function staleGoalTodoReminder(goal, nagText = DEFAULT_TODO_NAG_TEXT) {
  if (goal !== null && goal.status !== "complete") return undefined;
  return nagText;
}

