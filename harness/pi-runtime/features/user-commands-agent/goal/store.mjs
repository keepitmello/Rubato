import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const STORE_VERSION = 1;
const locks = new Map();

export const GOAL_STATUS_VALUES = Object.freeze(["active", "paused", "blocked", "complete"]);
export const MODEL_SETTABLE_GOAL_STATUS_VALUES = Object.freeze(["complete", "blocked"]);
export const MAX_OBJECTIVE_LENGTH = 4000;
export const GOAL_CONTINUATION_CAP = 8;

export function encodedThreadId(ref) {
  return encodeURIComponent(ref.threadId);
}

export function goalFilePath(ref) {
  return join(ref.baseDir, encodedThreadId(ref) + ".json");
}

export function goalStoreRef(sessionManager, agentDir) {
  const sessionFile = sessionManager.getSessionFile?.();
  const sessionDir = sessionManager.getSessionDir?.();
  const threadId = sessionManager.getSessionId();
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
    throw new Error("goal store requires an absolute agentDir");
  }
  const persistedDir = typeof sessionDir === "string" && sessionDir.length > 0 && isAbsolute(sessionDir) ? sessionDir : undefined;
  const baseDir = sessionFile && persistedDir
    ? join(persistedDir, "extensions", "goal")
    : join(agentDir, "extensions", "goal", "no-session");
  return { baseDir, threadId };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function withLock(path, fn) {
  const previous = locks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(path, next.catch(() => {}));
  return next;
}

function validateObjective(value) {
  const objective = String(value ?? "").trim();
  if (objective.length === 0) throw new Error("objective must not be empty");
  if ([...objective].length > MAX_OBJECTIVE_LENGTH) {
    return { objective: [...objective].slice(0, MAX_OBJECTIVE_LENGTH).join(""), truncated: true };
  }
  return { objective, truncated: false };
}

async function readGoalFile(ref) {
  try {
    const parsed = JSON.parse(await readFile(goalFilePath(ref), "utf8"));
    if (parsed?.version !== STORE_VERSION) throw new Error("unsupported goal store version");
    return parsed.goal ?? null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeGoalFile(ref, goal) {
  const filePath = goalFilePath(ref);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), ".goal-" + randomUUID() + ".tmp");
  try {
    await writeFile(tempPath, JSON.stringify({ version: STORE_VERSION, goal }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readGoal(ref) {
  return readGoalFile(ref);
}

export async function createGoal(ref, objective) {
  return withLock(goalFilePath(ref), async () => {
    const validated = validateObjective(objective);
    const current = await readGoalFile(ref);
    if (current !== null && current.status !== "complete") {
      throw new Error("cannot create a new goal because this thread already has a goal");
    }
    const now = nowSeconds();
    const goal = {
      id: randomUUID(),
      threadId: ref.threadId,
      objective: validated.objective,
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      consecutiveContinuations: 0,
      unattendedContinuations: 0,
      createdAt: now,
      updatedAt: now,
      lastStartedAt: now,
    };
    await writeGoalFile(ref, goal);
    return goal;
  });
}

export async function updateGoal(ref, update, source = "model") {
  return withLock(goalFilePath(ref), async () => {
    const current = await readGoalFile(ref);
    if (!current) throw new Error("cannot update goal: no goal exists");
    const now = nowSeconds();
    let next = { ...current, updatedAt: now };
    if (update.objective !== undefined) {
      const validated = validateObjective(update.objective);
      if (validated.objective !== current.objective || current.status === "complete") {
        next = {
          id: randomUUID(),
          threadId: ref.threadId,
          objective: validated.objective,
          status: update.status ?? "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          consecutiveContinuations: 0,
          unattendedContinuations: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (next.status === "active") next.lastStartedAt = now;
        await writeGoalFile(ref, next);
        return next;
      }
      next.objective = validated.objective;
    }
    if (update.status !== undefined && update.status !== current.status) {
      if (source === "model" && !MODEL_SETTABLE_GOAL_STATUS_VALUES.includes(update.status)) {
        throw new Error("model cannot set goal status to " + update.status);
      }
      if (update.status === "blocked") {
        const reason = String(update.reason ?? "").trim();
        if (!reason) throw new Error("reason is required when status is blocked");
        next.blockedReason = reason;
        next.blockedAt = now;
      }
      if (update.status === "complete") {
        if (update.reason) throw new Error("reason must not be provided when status is complete");
        next.completedAt = now;
        delete next.blockedReason;
      }
      if (update.status === "active") {
        next.lastStartedAt = now;
        delete next.blockedReason;
      }
      next.status = update.status;
      next.consecutiveContinuations = 0;
      next.unattendedContinuations = 0;
    }
    if (update.tokensUsed !== undefined) next.tokensUsed = update.tokensUsed;
    if (update.timeUsedSeconds !== undefined) next.timeUsedSeconds = update.timeUsedSeconds;
    if (update.consecutiveContinuations !== undefined) next.consecutiveContinuations = update.consecutiveContinuations;
    await writeGoalFile(ref, next);
    return next;
  });
}

export async function clearGoal(ref) {
  return withLock(goalFilePath(ref), async () => {
    const hadGoal = (await readGoalFile(ref)) !== null;
    await writeGoalFile(ref, null);
    return hadGoal;
  });
}

export async function recordContinuationDelivered(ref, expectedGoalId) {
  return withLock(goalFilePath(ref), async () => {
    const goal = await readGoalFile(ref);
    if (!goal || goal.id !== expectedGoalId || goal.status !== "active") return null;
    if ((goal.consecutiveContinuations ?? 0) >= GOAL_CONTINUATION_CAP) return null;
    goal.consecutiveContinuations = (goal.consecutiveContinuations ?? 0) + 1;
    goal.unattendedContinuations = (goal.unattendedContinuations ?? 0) + 1;
    goal.updatedAt = nowSeconds();
    await writeGoalFile(ref, goal);
    return goal;
  });
}
