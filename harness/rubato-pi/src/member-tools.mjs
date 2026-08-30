import { claimTask, getTask, listTasks, updateTask } from "./member-board.mjs";

function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

export function registerMemberBoardTools(pi, identity) {
  const { stateDir, teamRunId, memberName } = identity;
  if (!stateDir || !teamRunId || !memberName) return;

  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description: "List this team's board. Members may only inspect the shared tasklist.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        owner: { type: "string" },
      },
    },
    async execute(_id, input = {}) {
      const tasks = await listTasks(stateDir, teamRunId, input);
      return textResult(`${tasks.length} task(s).`, { kind: "list", tasks });
    },
  });

  pi.registerTool({
    name: "task_get",
    label: "Task Get",
    description: "Read one board task.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
    async execute(_id, input) {
      const task = await getTask(stateDir, teamRunId, input.task_id);
      return textResult(`${task.id} [${task.status}] ${task.subject}`, { kind: "get", task });
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Task Update",
    description: "Claim or update a board task as this member. Cross-owner updates are rejected.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string" },
        done_evidence: { type: "string" },
        budget_return: { type: "boolean" },
      },
      required: ["task_id", "status"],
    },
    async execute(_id, input) {
      const metadata = {};
      if (input.done_evidence) metadata.done_evidence = input.done_evidence;
      if (input.budget_return) metadata.budget_return = true;
      const task = await updateTask(
        stateDir,
        teamRunId,
        input.task_id,
        memberName,
        input.status,
        Object.keys(metadata).length > 0 ? metadata : undefined,
      );
      return textResult(`Updated ${task.id} to ${task.status}`, { kind: "updated", task });
    },
  });
}

export async function restoreMemberTaskEngine(compose, taskComponent, pi) {
  const previous = process.env.SENPI_TASK_MEMBER;
  delete process.env.SENPI_TASK_MEMBER;
  try {
    await compose([taskComponent])(pi);
  } finally {
    if (previous !== undefined) process.env.SENPI_TASK_MEMBER = previous;
  }
}
