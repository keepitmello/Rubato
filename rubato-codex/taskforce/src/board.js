import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

export const TASK_STATUSES = ["pending", "claimed", "in_progress", "completed", "deleted"]

const STATUS_SET = new Set(TASK_STATUSES)
const TRANSITIONS = {
  pending: new Set(["claimed", "in_progress", "deleted"]),
  claimed: new Set(["in_progress", "deleted"]),
  in_progress: new Set(["completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
}

export class BoardError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = "BoardError"
    this.code = code
    this.details = details
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BoardError("invalid_input", `${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined) return undefined
  return requiredString(value, name)
}

function taskId(value) {
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== String(value)) {
    throw new BoardError("invalid_input", "task_id must be a positive integer")
  }
  return number
}

function normalizeBlockedBy(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BoardError("invalid_input", "blocked_by must be an array")
  const result = value.map(taskId)
  if (new Set(result).size !== result.length) {
    throw new BoardError("invalid_input", "blocked_by must not contain duplicates")
  }
  return result
}

function normalizeMetadata(input) {
  if (input.metadata !== undefined && (typeof input.metadata !== "object" || input.metadata === null || Array.isArray(input.metadata))) {
    throw new BoardError("invalid_input", "metadata must be an object")
  }
  const metadata = { ...(input.metadata ?? {}) }
  for (const [inputName, key] of [
    ["outcome", "outcome"],
    ["write_ownership", "writeOwnership"],
    ["budget", "budget"],
    ["done_evidence", "doneEvidence"],
  ]) {
    const value = optionalString(input[inputName], inputName)
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}

function normalizeScope(input, defaults) {
  const workspaceInput = requiredString(input.workspace ?? defaults.workspace, "workspace")
  if (!path.isAbsolute(workspaceInput)) {
    throw new BoardError("invalid_input", "workspace must be an absolute path")
  }
  const workspace = path.resolve(workspaceInput)
  const runId = requiredString(input.run_id ?? defaults.runId, "run_id")
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new BoardError("invalid_input", "run_id contains unsupported characters")
  }
  return { workspace, runId, scope: scopeId(workspace, runId) }
}

function scopeId(workspace, runId) {
  return createHash("sha256").update(workspace).update("\0").update(runId).digest("hex")
}

export function resolveStateDir(options = {}, env = process.env, homeDirectory = homedir()) {
  const codexHome = options.codexHome ?? env.CODEX_HOME ?? path.join(homeDirectory, ".codex")
  return path.resolve(options.stateDir ?? env.TASKFORCE_STATE_DIR ?? path.join(codexHome, "taskforce"))
}

function decodeTask(row, events = []) {
  return {
    id: String(row.task_id),
    subject: row.subject,
    description: row.description,
    status: row.status,
    ...(row.owner === null ? {} : { owner: row.owner }),
    blockedBy: JSON.parse(row.blocked_by),
    metadata: JSON.parse(row.metadata),
    evidence: JSON.parse(row.evidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(events.length === 0 ? {} : { events }),
  }
}

export class TaskBoard {
  constructor(options = {}) {
    this.defaults = {
      workspace: options.workspace ?? process.env.TASKFORCE_WORKSPACE,
      runId: options.runId ?? process.env.TASKFORCE_RUN_ID,
    }
    const stateDir = resolveStateDir(options)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.databasePath = path.join(stateDir, "taskforce.sqlite")
    this.db = new DatabaseSync(this.databasePath)
    this.db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    this.#migrate()
  }

  close() {
    this.db.close()
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scopes (
        scope TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        run_id TEXT NOT NULL,
        next_task_id INTEGER NOT NULL DEFAULT 1,
        UNIQUE(workspace, run_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        scope TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','in_progress','completed','deleted')),
        owner TEXT,
        blocked_by TEXT NOT NULL,
        metadata TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        PRIMARY KEY(scope, task_id),
        FOREIGN KEY(scope) REFERENCES scopes(scope)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT,
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(scope, task_id) REFERENCES tasks(scope, task_id)
      );
      CREATE INDEX IF NOT EXISTS task_events_lookup ON task_events(scope, task_id, event_id);
    `)
  }

  #transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = fn()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch {}
      throw error
    }
  }

  #row(scope, id) {
    return this.db.prepare("SELECT * FROM tasks WHERE scope = ? AND task_id = ?").get(scope, id)
  }

  #requireRow(scope, id) {
    const row = this.#row(scope, id)
    if (row === undefined) throw new BoardError("not_found", `task ${id} was not found`)
    return row
  }

  #events(scope, id) {
    return this.db.prepare("SELECT kind, actor, details, created_at FROM task_events WHERE scope = ? AND task_id = ? ORDER BY event_id")
      .all(scope, id)
      .map((row) => ({
        kind: row.kind,
        ...(row.actor === null ? {} : { actor: row.actor }),
        details: JSON.parse(row.details),
        createdAt: row.created_at,
      }))
  }

  #event(scope, id, kind, actor, details, now) {
    this.db.prepare("INSERT INTO task_events(scope, task_id, kind, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scope, id, kind, actor ?? null, JSON.stringify(details), now)
  }

  create(input) {
    const context = normalizeScope(input, this.defaults)
    const subject = requiredString(input.subject, "subject")
    const description = requiredString(input.description, "description")
    const blockedBy = normalizeBlockedBy(input.blocked_by)
    const metadata = normalizeMetadata(input)
    return this.#transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO scopes(scope, workspace, run_id) VALUES (?, ?, ?)")
        .run(context.scope, context.workspace, context.runId)
      for (const blocker of blockedBy) this.#requireRow(context.scope, blocker)
      const sequence = this.db.prepare("SELECT next_task_id FROM scopes WHERE scope = ?").get(context.scope)
      const id = sequence.next_task_id
      this.db.prepare("UPDATE scopes SET next_task_id = next_task_id + 1 WHERE scope = ?").run(context.scope)
      const now = Date.now()
      this.db.prepare(`
        INSERT INTO tasks(scope, task_id, subject, description, status, owner, blocked_by, metadata, evidence, created_at, updated_at, claimed_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, '[]', ?, ?, NULL)
      `).run(context.scope, id, subject, description, JSON.stringify(blockedBy), JSON.stringify(metadata), now, now)
      this.#event(context.scope, id, "created", null, { blockedBy }, now)
      return decodeTask(this.#requireRow(context.scope, id), this.#events(context.scope, id))
    })
  }

  list(input = {}) {
    const context = normalizeScope(input, this.defaults)
    const clauses = ["scope = ?"]
    const values = [context.scope]
    if (input.status !== undefined) {
      if (!STATUS_SET.has(input.status)) throw new BoardError("invalid_input", "unknown status")
      clauses.push("status = ?")
      values.push(input.status)
    }
    if (input.owner !== undefined) {
      clauses.push("owner = ?")
      values.push(requiredString(input.owner, "owner"))
    }
    return this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY task_id`).all(...values).map((row) => decodeTask(row))
  }

  get(input) {
    const context = normalizeScope(input, this.defaults)
    const id = taskId(input.task_id)
    return decodeTask(this.#requireRow(context.scope, id), this.#events(context.scope, id))
  }

  update(input) {
    const context = normalizeScope(input, this.defaults)
    const id = taskId(input.task_id)
    const actor = requiredString(input.actor, "actor")
    const status = input.status
    const reassignTo = optionalString(input.reassign_to, "reassign_to")
    if ((status === undefined) === (reassignTo === undefined)) {
      throw new BoardError("invalid_input", "provide exactly one of status or reassign_to")
    }
    return this.#transaction(() => {
      const row = this.#requireRow(context.scope, id)
      const now = Date.now()
      if (reassignTo !== undefined) {
        const reason = requiredString(input.recovery_reason, "recovery_reason")
        if (row.status !== "claimed" && row.status !== "in_progress") {
          throw new BoardError("invalid_transition", `cannot reassign a ${row.status} task`)
        }
        this.db.prepare("UPDATE tasks SET owner = ?, status = 'claimed', claimed_at = ?, updated_at = ? WHERE scope = ? AND task_id = ?")
          .run(reassignTo, now, now, context.scope, id)
        this.#event(context.scope, id, "reassigned", actor, { from: row.owner, to: reassignTo, reason }, now)
        return decodeTask(this.#requireRow(context.scope, id), this.#events(context.scope, id))
      }

      if (!STATUS_SET.has(status)) throw new BoardError("invalid_input", "unknown status")
      if (row.status === status) {
        if (row.owner !== null && row.owner !== actor) {
          throw new BoardError(status === "claimed" ? "already_claimed" : "cross_owner", `task ${id} belongs to ${row.owner}`)
        }
        return decodeTask(row, this.#events(context.scope, id))
      }
      if (!TRANSITIONS[row.status].has(status)) {
        throw new BoardError("invalid_transition", `cannot move task ${id} from ${row.status} to ${status}`)
      }
      if (row.status === "pending" && (status === "claimed" || status === "in_progress")) {
        const blockers = JSON.parse(row.blocked_by)
        const blocked = blockers.filter((blocker) => this.#requireRow(context.scope, blocker).status !== "completed")
        if (blocked.length > 0) throw new BoardError("blocked_by", `task ${id} is blocked`, { blockers: blocked.map(String) })
      } else if (row.owner !== null && row.owner !== actor) {
        throw new BoardError("cross_owner", `task ${id} belongs to ${row.owner ?? "nobody"}`)
      }

      const owner = row.status === "pending" && (status === "claimed" || status === "in_progress") ? actor : row.owner
      const claimedAt = owner !== null && row.claimed_at === null ? now : row.claimed_at
      const evidence = JSON.parse(row.evidence)
      if (status === "completed") evidence.push(requiredString(input.evidence, "evidence"))
      this.db.prepare("UPDATE tasks SET status = ?, owner = ?, evidence = ?, claimed_at = ?, updated_at = ? WHERE scope = ? AND task_id = ?")
        .run(status, owner, JSON.stringify(evidence), claimedAt, now, context.scope, id)
      this.#event(context.scope, id, "status_changed", actor, { from: row.status, to: status, ...(status === "completed" ? { evidence: evidence.at(-1) } : {}) }, now)
      return decodeTask(this.#requireRow(context.scope, id), this.#events(context.scope, id))
    })
  }
}

export function openBoard(options) {
  return new TaskBoard(options)
}
