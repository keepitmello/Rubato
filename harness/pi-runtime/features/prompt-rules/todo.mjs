import { Type } from "typebox";

export const TODO_STATE_ENTRY_TYPE = "senpi.todo-state";
const DEFAULT_PHASE = "Tasks";
const STATUSES = new Set(["pending", "in_progress", "completed", "abandoned"]);

export const TODO_TOOL_DESCRIPTION = `Tasks are referenced by their verbatim content string, never by an auto-generated id.

Operations:
- init: replace the list with list: [{phase, items}] or items: string[]
- start: mark one exact task in progress
- done/drop: close an exact task, or every task in an exact phase
- append: add unique tasks to a phase
- rm: remove a task, clear a phase, or clear everything
- view: return the current list without changing persisted state

Keep task and phase strings stable. Complete phases in order and update a task as soon as its work finishes.`;

export const TASK_MANAGEMENT_SECTION = `
<Task_Management>
## Todo Management

Use the todo tool for multi-step work. Mark each item done when it finishes and reconcile the list against the newest user message before ending a turn.
</Task_Management>
`;

const Params = Type.Object({
  op: Type.Union([
    Type.Literal("init"),
    Type.Literal("start"),
    Type.Literal("done"),
    Type.Literal("drop"),
    Type.Literal("append"),
    Type.Literal("rm"),
    Type.Literal("view"),
  ]),
  list: Type.Optional(Type.Array(Type.Object({
    phase: Type.String(),
    items: Type.Array(Type.String(), { minItems: 1 }),
  }))),
  items: Type.Optional(Type.Array(Type.String())),
  task: Type.Optional(Type.String()),
  phase: Type.Optional(Type.String()),
});

function clone(phases) {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
  }));
}

function parseTask(value, lenient = false) {
  if (!value || typeof value !== "object" || typeof value.content !== "string") return undefined;
  const status = value.status === "cancelled"
    ? "abandoned"
    : (STATUSES.has(value.status) ? value.status : (lenient ? "pending" : undefined));
  return status ? { content: value.content, status } : undefined;
}

function parsePhases(value) {
  if (!Array.isArray(value)) return undefined;
  const phases = [];
  for (const phase of value) {
    if (!phase || typeof phase !== "object" || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
    const tasks = phase.tasks.map((task) => parseTask(task));
    if (tasks.some((task) => !task)) return undefined;
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

function phasesFromPayload(value) {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value.phases)) return parsePhases(value.phases);
  if (Array.isArray(value.todos)) {
    const tasks = value.todos.map((todo) => parseTask(todo, true));
    return tasks.some((task) => !task) ? undefined : [{ name: DEFAULT_PHASE, tasks }];
  }
  return undefined;
}

export function latestPhases(entries) {
  let phases = [];
  for (const entry of entries) {
    let payload;
    if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) payload = entry.data;
    if (entry.type === "message" && entry.message?.role === "toolResult"
      && (entry.message.toolName === "todo" || entry.message.toolName === "todowrite")) {
      payload = entry.message.details;
    }
    const parsed = phasesFromPayload(payload);
    if (parsed) phases = clone(parsed);
  }
  return phases;
}

function findTask(phases, content) {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.content === content);
    if (task) return { phase, task };
  }
  return undefined;
}

function findPhase(phases, name) {
  return phases.find((phase) => phase.name === name);
}

function normalizeProgress(phases) {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const inProgress = tasks.filter((task) => task.status === "in_progress");
  for (const task of inProgress.slice(1)) task.status = "pending";
  if (inProgress.length === 0) {
    const next = tasks.find((task) => task.status === "pending");
    if (next) next.status = "in_progress";
  }
}

function exactTask(phases, content) {
  if (!content) throw new Error("Missing task content");
  const hit = findTask(phases, content);
  if (!hit) {
    const suffix = /^task-\d+$/.test(content) ? " Tasks are referenced by content, not ids." : "";
    throw new Error(`Task "${content}" not found.${suffix}`);
  }
  return hit;
}

function exactPhase(phases, name) {
  if (!name) throw new Error("Missing phase name");
  const phase = findPhase(phases, name);
  if (!phase) throw new Error(`Phase "${name}" not found`);
  return phase;
}

function init(params) {
  const list = params.list ?? (params.items ? [{ phase: params.phase ?? DEFAULT_PHASE, items: params.items }] : undefined);
  if (!list) throw new Error("Missing list for init operation");
  const phases = [];
  const byName = new Map();
  const tasks = new Set();
  for (const entry of list) {
    let phase = byName.get(entry.phase);
    if (!phase) {
      phase = { name: entry.phase, tasks: [] };
      phases.push(phase);
      byName.set(entry.phase, phase);
    }
    for (const content of entry.items) {
      if (tasks.has(content)) continue;
      tasks.add(content);
      phase.tasks.push({ content, status: "pending" });
    }
  }
  normalizeProgress(phases);
  return phases;
}

function apply(phases, params) {
  const next = clone(phases);
  if (params.op === "init") return init(params);
  if (params.op === "view") return next;
  if (params.op === "append") {
    if (!params.items?.length) throw new Error("Missing items for append operation");
    for (const content of params.items) {
      if (findTask(next, content)) throw new Error(`Task "${content}" already exists`);
    }
    const active = next.flatMap((phase) => phase.tasks.map((task) => ({ phase, task })))
      .find(({ task }) => task.status === "in_progress" || task.status === "pending");
    const name = params.phase ?? active?.phase.name ?? next.at(-1)?.name ?? DEFAULT_PHASE;
    let phase = findPhase(next, name);
    if (!phase) {
      phase = { name, tasks: [] };
      next.push(phase);
    }
    phase.tasks.push(...params.items.map((content) => ({ content, status: "pending" })));
  } else if (params.op === "start") {
    const hit = exactTask(next, params.task);
    for (const phase of next) {
      for (const task of phase.tasks) if (task.status === "in_progress") task.status = "pending";
    }
    hit.task.status = "in_progress";
  } else if (params.op === "done" || params.op === "drop") {
    const status = params.op === "done" ? "completed" : "abandoned";
    if (params.task) exactTask(next, params.task).task.status = status;
    else for (const task of exactPhase(next, params.phase).tasks) task.status = status;
  } else if (params.op === "rm") {
    if (params.task) {
      const hit = exactTask(next, params.task);
      hit.phase.tasks = hit.phase.tasks.filter((task) => task !== hit.task);
    } else if (params.phase) {
      exactPhase(next, params.phase).tasks = [];
    } else {
      return [];
    }
  }
  normalizeProgress(next);
  return next;
}

function summary(phases, readOnly) {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return readOnly ? "Todo list is empty." : "Todo list cleared.";
  const open = tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
  const lines = [
    open.length === 0 ? "Remaining items: none." : `Remaining items (${open.length}):`,
  ];
  if (open.length > 0) {
    for (const phase of phases) {
      for (const task of phase.tasks) {
        if (task.status === "pending" || task.status === "in_progress") {
          lines.push(`  - ${task.content} [${task.status}] (${phase.name})`);
        }
      }
    }
  }
  lines.push(`Overall: ${tasks.length - open.length}/${tasks.length} done, ${open.length} open.`);
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const mark = task.status === "completed" ? "[X]" : "[ ]";
      const suffix = task.status === "in_progress" ? " (in progress)" : task.status === "abandoned" ? " (dropped)" : "";
      lines.push(`    - ${mark} ${task.content}${suffix}`);
    }
  }
  return lines.join("\n");
}

export function createTodoExtension() {
  return (pi) => {
    let current = [];
    const sync = (ctx) => {
      current = latestPhases(ctx.sessionManager.getBranch());
    };
    pi.on("session_start", (_event, ctx) => sync(ctx));
    pi.on("session_tree", (_event, ctx) => sync(ctx));
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n${TASK_MANAGEMENT_SECTION}`,
    }));
    pi.registerTool({
      name: "todo",
      label: "Todo",
      description: TODO_TOOL_DESCRIPTION,
      promptSnippet: "Track phased tasks with one op-based todo tool; reference tasks by exact content.",
      promptGuidelines: [
        "Reference todo tasks and phases by exact content/name.",
        "Mark completed work immediately and use drop for work no longer needed.",
      ],
      parameters: Params,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const readOnly = params.op === "view";
        const next = apply(current, params);
        if (!readOnly) {
          current = clone(next);
          pi.appendEntry(TODO_STATE_ENTRY_TYPE, { schema: "v2", phases: clone(next) });
        }
        return {
          content: [{ type: "text", text: summary(next, readOnly) }],
          details: {
            op: params.op,
            phases: clone(next),
            storage: ctx.sessionManager.getSessionFile() ? "session" : "memory",
          },
        };
      },
    });
  };
}
