import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TRANSITIONS = {
  pending: ["claimed", "deleted"],
  claimed: ["in_progress", "deleted"],
  in_progress: ["completed", "deleted"],
  completed: ["deleted"],
  deleted: [],
};

export function taskDir(stateDir, teamRunId) {
  return join(stateDir, "runtime", teamRunId, "tasks");
}

function taskPath(stateDir, teamRunId, taskId) {
  return join(taskDir(stateDir, teamRunId), `${taskId}.json`);
}

function claimLockPath(stateDir, teamRunId, taskId) {
  return join(taskDir(stateDir, teamRunId), "claims", `${taskId}.lock`);
}

async function readTaskFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function listTasks(stateDir, teamRunId, filter = {}) {
  const dir = taskDir(stateDir, teamRunId);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    try {
      tasks.push(await readTaskFile(join(dir, entry.name)));
    } catch {
      continue;
    }
  }
  return tasks.filter(
    (task) =>
      (filter.status === undefined || task.status === filter.status) &&
      (filter.owner === undefined || task.owner === filter.owner),
  );
}

export async function getTask(stateDir, teamRunId, taskId) {
  return readTaskFile(taskPath(stateDir, teamRunId, taskId));
}

export async function claimTask(stateDir, teamRunId, taskId, memberName) {
  const task = await getTask(stateDir, teamRunId, taskId);
  if (task.status !== "pending") {
    const error = new Error("already_claimed");
    error.code = "already_claimed";
    throw error;
  }
  const all = await listTasks(stateDir, teamRunId);
  const blockers = (task.blockedBy ?? []).filter((id) => {
    const other = all.find((item) => item.id === id);
    return other && other.status !== "completed";
  });
  if (blockers.length > 0) {
    const error = new Error(`blocked by ${blockers.join(",")}`);
    error.code = "blocked_by";
    error.blockers = blockers;
    throw error;
  }
  await mkdir(join(taskDir(stateDir, teamRunId), "claims"), { recursive: true });
  try {
    await writeFile(claimLockPath(stateDir, teamRunId, taskId), memberName, { flag: "wx" });
  } catch {
    const error = new Error("already_claimed");
    error.code = "already_claimed";
    throw error;
  }
  const now = Date.now();
  const claimed = { ...task, status: "claimed", owner: memberName, claimedAt: now, updatedAt: now };
  await writeFile(taskPath(stateDir, teamRunId, taskId), `${JSON.stringify(claimed, null, 2)}\n`);
  return claimed;
}

export async function updateTask(stateDir, teamRunId, taskId, memberName, status, metadata) {
  if (status === "claimed") return claimTask(stateDir, teamRunId, taskId, memberName);
  const task = await getTask(stateDir, teamRunId, taskId);
  if (task.status === status) return task;
  if (task.status === "pending" && status === "in_progress") {
    await claimTask(stateDir, teamRunId, taskId, memberName);
    return updateTask(stateDir, teamRunId, taskId, memberName, status, metadata);
  }
  const allowed = TRANSITIONS[task.status] ?? [];
  if (!allowed.includes(status)) {
    const error = new Error(`no reverse transitions from ${task.status} to ${status}`);
    error.code = "invalid_transition";
    throw error;
  }
  if (status !== "deleted" && task.owner !== memberName) {
    const error = new Error("cross-owner updates are not allowed");
    error.code = "cross_owner";
    throw error;
  }
  const updated = {
    ...task,
    status,
    updatedAt: Date.now(),
    ...(metadata ? { metadata: { ...task.metadata, ...metadata } } : {}),
  };
  await writeFile(taskPath(stateDir, teamRunId, taskId), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
