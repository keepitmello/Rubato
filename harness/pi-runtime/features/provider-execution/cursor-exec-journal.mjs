/**
 * Durable Cursor exec journal for the stock-Pi candidate.
 *
 * Contract (product harness/rubato-pi cursor-exec-journal, READ-ONLY reference):
 * prepared -> executing -> completed | failed | unknown.
 * executing left by a dead pid settles to unknown and never auto-retries.
 * completed/failed with a persisted result replay; they never run again.
 * Identity is {lineageId, execId}. The transport may suffix toolCallId for
 * transcript uniqueness; that suffix is not this journal's key.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CURSOR_EXEC_PREPARED = "prepared";
export const CURSOR_EXEC_EXECUTING = "executing";
export const CURSOR_EXEC_COMPLETED = "completed";
export const CURSOR_EXEC_FAILED = "failed";
export const CURSOR_EXEC_UNKNOWN = "unknown";
export const CURSOR_EXEC_JOURNAL_VERSION = 1;
export const CURSOR_EXEC_JOURNAL_FILE = "cursor-exec-journal.json";
export const CURSOR_EXEC_JOURNAL_MAX_ENTRIES = 512;
export const CURSOR_EXEC_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CURSOR_EXEC_LEDGER_MAX_IDS = 50_000;
export const CURSOR_EXEC_LEDGER_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const CURSOR_SIDE_EFFECT_NONE = "none";
export const CURSOR_SIDE_EFFECT_UNKNOWN = "unknown";
export const CURSOR_SIDE_EFFECT_HAPPENED = "happened";

const LEDGER_COMPLETED = "c";
const LEDGER_FAILED = "f";
const LEDGER_UNKNOWN = "u";
const LEDGER_NOT_RUN = "n";
const TERMINAL = new Set([CURSOR_EXEC_COMPLETED, CURSOR_EXEC_FAILED, CURSOR_EXEC_UNKNOWN]);
const UNREADABLE = Symbol("cursor-exec-journal-unreadable");

export function cursorExecJournalPath(agentDir) {
  if (typeof agentDir !== "string" || agentDir.trim() === "") {
    throw new Error("cursor exec journal requires an isolated agentDir");
  }
  return join(agentDir, CURSOR_EXEC_JOURNAL_FILE);
}

function entryKey(lineageId, execId) {
  return lineageId + "\u0000" + execId;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState() {
  return { version: CURSOR_EXEC_JOURNAL_VERSION, entries: {}, ledger: {} };
}

function unreadableState(reason) {
  const state = emptyState();
  state[UNREADABLE] = reason;
  return state;
}

function unreadableReasonOf(state) {
  const reason = state?.[UNREADABLE];
  return typeof reason === "string" && reason !== "" ? reason : undefined;
}

function ownerAlive(pid, self) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === self) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function atomicWriteJournalSync(journalPath, contents) {
  const payload = Buffer.from(contents, "utf8");
  const tempPath = journalPath + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      if (n <= 0) throw new Error("cursor exec journal write stalled after " + written + " of " + payload.length + " bytes");
      written += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, journalPath);
  try {
    const dirFd = openSync(dirname(journalPath), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Directory fsync is best-effort on platforms that refuse it.
  }
}

function parseState(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: "the exec journal is present but is not valid JSON" }; }
  if (!isPlainObject(parsed)) return { ok: false, reason: "the exec journal is present but is not a JSON object" };
  if (parsed.version !== CURSOR_EXEC_JOURNAL_VERSION) {
    return { ok: false, reason: "the exec journal is version " + String(parsed.version) + ", which this process does not read" };
  }
  if (parsed.entries !== undefined && !isPlainObject(parsed.entries)) {
    return { ok: false, reason: "the exec journal entries table is malformed" };
  }
  if (parsed.ledger !== undefined && !isPlainObject(parsed.ledger)) {
    return { ok: false, reason: "the exec journal ledger is malformed" };
  }
  const clean = {};
  for (const [key, value] of Object.entries(parsed.entries ?? {})) {
    if (!isPlainObject(value) || typeof value.state !== "string") continue;
    clean[key] = value;
  }
  const ledger = {};
  for (const [lineageId, record] of Object.entries(parsed.ledger ?? {})) {
    if (!isPlainObject(record)) continue;
    const ids = isPlainObject(record.ids) ? record.ids : {};
    const cleanIds = {};
    for (const [execId, code] of Object.entries(ids)) {
      if (typeof code === "string" && code !== "") cleanIds[execId] = code;
    }
    ledger[lineageId] = {
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      ids: cleanIds,
    };
  }
  return { ok: true, state: { version: CURSOR_EXEC_JOURNAL_VERSION, entries: clean, ledger } };
}

function ledgerCodeForState(stateName, isError) {
  if (stateName === CURSOR_EXEC_UNKNOWN) return LEDGER_UNKNOWN;
  if (stateName === CURSOR_EXEC_COMPLETED) return LEDGER_COMPLETED;
  if (stateName === CURSOR_EXEC_FAILED || isError) return LEDGER_FAILED;
  return LEDGER_NOT_RUN;
}

function rememberInLedger(state, lineageId, execId, code, stamp) {
  const record = state.ledger[lineageId] ?? { updatedAt: 0, ids: {} };
  record.ids[execId] = code;
  record.updatedAt = stamp;
  state.ledger[lineageId] = record;
}

function ledgerCodeOf(state, lineageId, execId) {
  return state.ledger[lineageId]?.ids?.[execId];
}

function prune(state, stamp, maxEntries, ttlMs) {
  for (const [key, entry] of Object.entries(state.entries)) {
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (stamp - updatedAt > ttlMs) delete state.entries[key];
  }
  const remaining = Object.entries(state.entries).sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  while (remaining.length > maxEntries) {
    const [key] = remaining.shift();
    delete state.entries[key];
  }
}

function pruneLedger(state, stamp, maxIds, ttlMs) {
  for (const [lineageId, record] of Object.entries(state.ledger)) {
    if (stamp - (record.updatedAt ?? 0) > ttlMs) delete state.ledger[lineageId];
  }
  const lineages = Object.entries(state.ledger).sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  let ids = lineages.reduce((n, rec) => n + Object.keys(rec[1].ids).length, 0);
  while (ids > maxIds && lineages.length > 0) {
    const [lineageId, record] = lineages.shift();
    ids -= Object.keys(record.ids).length;
    delete state.ledger[lineageId];
  }
}

function settlement(entry, stamp) {
  if (entry.state === CURSOR_EXEC_PREPARED) {
    return {
      state: CURSOR_EXEC_FAILED,
      sideEffect: CURSOR_SIDE_EFFECT_NONE,
      reason: "the owning process ended before execution began; the tool did not run",
      settledFrom: entry.state,
      settledAt: stamp,
    };
  }
  return {
    state: CURSOR_EXEC_UNKNOWN,
    sideEffect: CURSOR_SIDE_EFFECT_UNKNOWN,
    reason: "the owning process ended while the tool was executing; whether the side effect happened is unknowable",
    settledFrom: entry.state,
    settledAt: stamp,
  };
}

function withLockFile(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; attempt <= 80; attempt++) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 80) throw error;
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  if (fd === undefined) throw new Error("cursor exec journal lock timed out");
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

export function createCursorExecJournal(options = {}) {
  const journalPath = options.journalPath ?? cursorExecJournalPath(options.agentDir);
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? CURSOR_EXEC_JOURNAL_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? CURSOR_EXEC_JOURNAL_TTL_MS;
  const pid = options.pid ?? process.pid;
  const isOwnerAlive = options.isOwnerAlive ?? ((owner) => ownerAlive(owner, pid));
  const ledgerMaxIds = options.ledgerMaxIds ?? CURSOR_EXEC_LEDGER_MAX_IDS;
  const ledgerTtlMs = options.ledgerTtlMs ?? CURSOR_EXEC_LEDGER_TTL_MS;
  let settled = false;

  function readUnlocked() {
    if (!existsSync(journalPath)) return emptyState();
    let raw;
    try { raw = readFileSync(journalPath, "utf8"); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return unreadableState("the exec journal exists but could not be read (" + detail + ")");
    }
    const parsed = parseState(raw);
    if (!parsed.ok) return unreadableState(parsed.reason);
    return parsed.state;
  }

  function withLock(fn) {
    return withLockFile(journalPath + ".lock", () => {
      const state = readUnlocked();
      const sealed = unreadableReasonOf(state) !== undefined;
      let changed = false;
      const result = fn(state, () => { if (!sealed) changed = true; });
      if (changed) {
        prune(state, now(), maxEntries, ttlMs);
        pruneLedger(state, now(), ledgerMaxIds, ledgerTtlMs);
        const serializable = { version: state.version, entries: state.entries, ledger: state.ledger };
        atomicWriteJournalSync(journalPath, JSON.stringify(serializable));
      }
      return result;
    });
  }

  function settleStaleUnlocked(state, markChanged) {
    if (unreadableReasonOf(state) !== undefined) return [];
    const out = [];
    const stamp = now();
    for (const [key, entry] of Object.entries(state.entries)) {
      if (TERMINAL.has(entry.state)) continue;
      if (isOwnerAlive(entry.pid)) continue;
      state.entries[key] = { ...entry, ...settlement(entry, stamp), updatedAt: stamp };
      rememberInLedger(state, entry.lineageId, entry.execId, ledgerCodeForState(state.entries[key].state, state.entries[key].isError), stamp);
      out.push(state.entries[key]);
      markChanged();
    }
    return out;
  }

  function ensureSettled() {
    if (settled) return [];
    settled = true;
    return withLock((state, markChanged) => settleStaleUnlocked(state, markChanged));
  }

  function refuseUnreadable(lineageId, execId, toolName, reason) {
    return {
      decision: "refuse",
      entry: { lineageId, execId, toolName, state: CURSOR_EXEC_UNKNOWN, sideEffect: CURSOR_SIDE_EFFECT_UNKNOWN, reason },
      reason,
    };
  }

  return {
    path: journalPath,
    settleStale: () => ensureSettled(),
    read(lineageId, execId) {
      return withLock((state) => {
        if (unreadableReasonOf(state) !== undefined) return undefined;
        return state.entries[entryKey(lineageId, execId)];
      });
    },
    prepare({ lineageId, execId, toolCallId, toolName, retryAuthorization } = {}) {
      ensureSettled();
      return withLock((state, markChanged) => {
        const sealed = unreadableReasonOf(state);
        if (sealed !== undefined) {
          return refuseUnreadable(lineageId, execId, toolName,
            sealed + "; tool execution is refused until the journal is recoverable or an operator resets it");
        }
        const key = entryKey(lineageId, execId);
        const stamp = now();
        const write = (entry) => { state.entries[key] = entry; markChanged(); return entry; };
        const retryOrRefuse = (entry) => {
          const authorized = retryAuthorization?.execId === execId || retryAuthorization?.toolCallId === toolCallId;
          if (authorized) {
            return {
              decision: "execute",
              entry: write({
                ...entry,
                state: CURSOR_EXEC_PREPARED,
                pid,
                attempt: (typeof entry.attempt === "number" ? entry.attempt : 1) + 1,
                retriedFrom: entry.state,
                result: undefined,
                resultPersisted: false,
                updatedAt: stamp,
              }),
            };
          }
          return {
            decision: "refuse",
            entry,
            reason: entry.reason ?? (entry.state === CURSOR_EXEC_UNKNOWN
              ? "the previous attempt's outcome is unknown"
              : "the previous attempt " + entry.state),
          };
        };
        const existing = state.entries[key];
        if (existing === undefined) {
          const code = ledgerCodeOf(state, lineageId, execId);
          if (code !== undefined) {
            const synthetic = {
              lineageId,
              execId,
              toolCallId,
              toolName,
              state: code === LEDGER_UNKNOWN ? CURSOR_EXEC_UNKNOWN
                : code === LEDGER_COMPLETED ? CURSOR_EXEC_COMPLETED
                  : CURSOR_EXEC_FAILED,
              sideEffect: code === LEDGER_NOT_RUN ? CURSOR_SIDE_EFFECT_NONE
                : code === LEDGER_UNKNOWN ? CURSOR_SIDE_EFFECT_UNKNOWN
                  : CURSOR_SIDE_EFFECT_HAPPENED,
              reason: "this exec identity was already recorded",
              recordEvicted: true,
            };
            return retryOrRefuse(synthetic);
          }
          rememberInLedger(state, lineageId, execId, LEDGER_NOT_RUN, stamp);
          return {
            decision: "execute",
            entry: write({
              lineageId,
              execId,
              toolCallId,
              toolName,
              state: CURSOR_EXEC_PREPARED,
              pid,
              attempt: 1,
              createdAt: stamp,
              updatedAt: stamp,
            }),
          };
        }
        if (existing.resultPersisted === true) return { decision: "replay", entry: existing };
        if (!TERMINAL.has(existing.state)) {
          if (isOwnerAlive(existing.pid)) {
            return {
              decision: "refuse",
              entry: existing,
              reason: existing.pid === pid
                ? "exec " + execId + " is already " + existing.state + " in this process"
                : "exec " + execId + " is " + existing.state + " in process " + existing.pid,
            };
          }
          const settledEntry = write({ ...existing, ...settlement(existing, stamp), updatedAt: stamp });
          rememberInLedger(state, lineageId, execId, ledgerCodeForState(settledEntry.state, settledEntry.isError), stamp);
          return retryOrRefuse(settledEntry);
        }
        return retryOrRefuse(existing);
      });
    },
    markExecuting(lineageId, execId) {
      return withLock((state, markChanged) => {
        const key = entryKey(lineageId, execId);
        const entry = state.entries[key];
        if (entry === undefined) return undefined;
        const stamp = now();
        state.entries[key] = { ...entry, state: CURSOR_EXEC_EXECUTING, pid, executingAt: stamp, updatedAt: stamp };
        markChanged();
        return state.entries[key];
      });
    },
    complete(lineageId, execId, { isError = false, result, summary } = {}) {
      return withLock((state, markChanged) => {
        const key = entryKey(lineageId, execId);
        const entry = state.entries[key];
        if (entry === undefined) return undefined;
        const stamp = now();
        state.entries[key] = {
          ...entry,
          state: isError ? CURSOR_EXEC_FAILED : CURSOR_EXEC_COMPLETED,
          isError,
          summary,
          result,
          resultPersisted: true,
          sideEffect: entry.state === CURSOR_EXEC_EXECUTING ? CURSOR_SIDE_EFFECT_HAPPENED : CURSOR_SIDE_EFFECT_NONE,
          completedAt: stamp,
          updatedAt: stamp,
        };
        rememberInLedger(state, lineageId, execId, ledgerCodeForState(state.entries[key].state, isError), stamp);
        markChanged();
        return state.entries[key];
      });
    },
    markResultDelivered(lineageId, execId) {
      return withLock((state, markChanged) => {
        const key = entryKey(lineageId, execId);
        const entry = state.entries[key];
        if (entry === undefined) return undefined;
        const stamp = now();
        state.entries[key] = { ...entry, resultDelivered: true, resultDeliveredAt: stamp, updatedAt: stamp };
        markChanged();
        return state.entries[key];
      });
    },
  };
}

