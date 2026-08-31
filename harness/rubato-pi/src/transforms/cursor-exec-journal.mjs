// In-repo copy of senpi `cursor-exec-journal.js` at the fully-patched
// final state (#14 journal + #15 explicit-retry + #16 fail-closed).
// Vendor file is created by the series — a load transform cannot invent it.
// Importers (cursor-exec-bridge) are rewritten to this href.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../engine-paths.mjs";

const require = createRequire(`${senpiDir}/package.json`);
const lockfile = require("proper-lockfile");
const { getAgentDir } = await import(pathToFileURL(`${senpiDir}/dist/config.js`).href);
const { FILE_STORAGE_LOCK_OPTIONS } = await import(pathToFileURL(`${senpiDir}/dist/core/lockfile-policy.js`).href);

export function cursorExecJournalHref() {
  return import.meta.url;
}

/**
 * Persistent execution journal for Cursor server-driven tool calls.
 *
 * Cursor executes tools server-drivenly: the server sends an exec frame and
 * blocks until the client answers in band. That makes the client the only place
 * that knows whether a side effect happened, and `kCursorExecResolved` only
 * knows it for the current process and the current call. A restart erases that
 * knowledge, so without a durable record the same `toolCallId` can run a second
 * time — a second `write`, a second `bash`, a second MCP mutation.
 *
 * This is the layer beneath the in-memory symbol: a file keyed by
 * `{conversationLineageId, toolCallId}` carrying
 * `prepared → executing → completed | failed | unknown`.
 *
 * What it does NOT promise is exactly-once across a restart. An arbitrary
 * external side effect and the transcript write cannot be made atomic, so a
 * process killed between the side effect and its record leaves a question no
 * amount of journalling can answer. The journal's job is to make that question
 * *visible* rather than silently answering it with a re-execution:
 *
 * - `completed` plus a persisted tool result → never execute again, replay.
 * - `executing` found at startup → settle to `unknown`. The side effect may or
 *   may not have landed; that is unknowable, so nothing is re-run.
 * - `unknown` is an error state. It surfaces to the user and the agent loop and
 *   never becomes a successful turn.
 * - Only a tool that explicitly declares an idempotency key may be retried, and
 *   only under that same key — **and only when a caller outside this journal
 *   explicitly authorizes that specific retry**. See `retryOrRefuse`: a key the
 *   tool advertises about itself is a precondition, never an authorization.
 *
 * Retention is split in two, because the two jobs have opposite lifetimes:
 *
 * - `entries` are rich diagnostic records (result payload, timestamps, pids).
 *   They are expensive per row, so they are bounded aggressively.
 * - `ledger` is the deduplication identity: per lineage, `toolCallId` → a
 *   one-character outcome code. That is all `prepare` needs in order to answer
 *   "have I run this key before", it costs a few dozen bytes per call, and it
 *   is retained far longer. Evicting *this* is what would let a redelivered
 *   frame execute a second time, so it is never dropped to make room for rich
 *   records, and it outlives both the entry cap and `forgetLineage`.
 *
 * The state and the result are written **together**, in one atomic write. Two
 * writes would open a window where the tool provably finished and its result
 * provably exists, yet the record says only `completed` — and a restart reading
 * that would have to report `unknown` for a turn that actually succeeded. The
 * design speaks of `completed` *and* a persisted result as one fact, so it is
 * stored as one fact.
 *
 * `cursor-exec-bridge` is the single owner. Writers are serialized with the same
 * `proper-lockfile` policy the auth and settings stores use, and each write is a
 * temp write → fsync → atomic rename, so a concurrent reader sees either the
 * complete previous JSON or the complete new JSON, never a torn file. Mode 0600:
 * the journal carries tool arguments and results.
 */
/** Journal states. `prepared`/`executing` are transient; the rest are terminal. */
export const CURSOR_EXEC_PREPARED = "prepared";
export const CURSOR_EXEC_EXECUTING = "executing";
export const CURSOR_EXEC_COMPLETED = "completed";
export const CURSOR_EXEC_FAILED = "failed";
export const CURSOR_EXEC_UNKNOWN = "unknown";
/** On-disk shape version. A file from another version is not guessed at. */
export const CURSOR_EXEC_JOURNAL_VERSION = 1;
export const CURSOR_EXEC_JOURNAL_FILE = "cursor-exec-journal.json";
/**
 * Bounds. The journal is a crash-recovery record, not a transcript: entries stay
 * only long enough for a restart to read them. Without a cap a long-lived
 * profile would grow one entry per tool call forever.
 */
export const CURSOR_EXEC_JOURNAL_MAX_ENTRIES = 512;
export const CURSOR_EXEC_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Dedup-identity retention. Deliberately far larger and far longer than the rich
 * records above, because this is the bound whose exhaustion would permit a
 * duplicate side effect rather than merely losing a diagnostic.
 *
 * A ledger row is `"<toolCallId>":"<code>"` — roughly 40-60 bytes of JSON for a
 * UUID-shaped id. 50,000 ids is on the order of 3 MB, and that is the ceiling
 * for an entire profile, not per session. Eviction is whole-lineage and
 * oldest-first: a lineage is a conversation, so dropping the oldest conversation
 * entire cannot split one live conversation's identity in half.
 */
export const CURSOR_EXEC_LEDGER_MAX_IDS = 50_000;
export const CURSOR_EXEC_LEDGER_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/**
 * What the journal knows about the side effect of an entry it settled.
 *
 * The distinction is not decoration: `none` and `happened` are facts a process
 * established before it died, and reporting them as `unknown` would throw away
 * evidence the user needs in order to decide what to do.
 */
export const CURSOR_SIDE_EFFECT_NONE = "none";
export const CURSOR_SIDE_EFFECT_UNKNOWN = "unknown";
export const CURSOR_SIDE_EFFECT_HAPPENED = "happened";
/**
 * Ledger outcome codes. One character, because this table is the thing we keep
 * when we have thrown everything else away.
 *
 * `c`/`f` ran and produced a result. `u` is the unknowable case. `n` provably
 * never ran (a `prepared` entry whose owner died before executing).
 */
const LEDGER_COMPLETED = "c";
const LEDGER_FAILED = "f";
const LEDGER_UNKNOWN = "u";
const LEDGER_NOT_RUN = "n";
const LEDGER_CODE = {
    [CURSOR_EXEC_COMPLETED]: LEDGER_COMPLETED,
    [CURSOR_EXEC_FAILED]: LEDGER_FAILED,
    [CURSOR_EXEC_UNKNOWN]: LEDGER_UNKNOWN,
};
/** Ledger code → the refusal a caller sees when the rich record is long gone. */
const LEDGER_REASON = {
    [LEDGER_COMPLETED]: "this tool call already completed in an earlier session; its result is no longer retained",
    [LEDGER_FAILED]: "this tool call already ran and failed in an earlier session; its result is no longer retained",
    [LEDGER_UNKNOWN]: "an earlier session left this tool call's outcome unknown",
    [LEDGER_NOT_RUN]: "an earlier session recorded this tool call but never executed it",
};
/** Ledger code → what we can still say about the side effect. */
const LEDGER_SIDE_EFFECT = {
    [LEDGER_COMPLETED]: CURSOR_SIDE_EFFECT_HAPPENED,
    [LEDGER_FAILED]: CURSOR_SIDE_EFFECT_HAPPENED,
    [LEDGER_UNKNOWN]: CURSOR_SIDE_EFFECT_UNKNOWN,
    [LEDGER_NOT_RUN]: CURSOR_SIDE_EFFECT_NONE,
};
/** Terminal states never move again on their own. */
const TERMINAL = new Set([CURSOR_EXEC_COMPLETED, CURSOR_EXEC_FAILED, CURSOR_EXEC_UNKNOWN]);
export function cursorExecJournalPath(agentDir) {
    return join(agentDir ?? getAgentDir(), CURSOR_EXEC_JOURNAL_FILE);
}
function entryKey(lineageId, toolCallId) {
    // NUL cannot occur in either id, so the join is unambiguous.
    return `${lineageId}\u0000${toolCallId}`;
}
/**
 * One factual line about tool calls whose outcome is unknown, or `undefined`.
 *
 * Deliberately quiet. The user is told a thing they need in order to decide
 * whether to check something, not warned at. No counts of scary adjectives, no
 * imperative — just which tools, and that it is unknown whether they ran.
 */
export function formatCursorExecUnresolvedNotice(entries) {
    if (!Array.isArray(entries) || entries.length === 0)
        return undefined;
    const names = [...new Set(entries.map((entry) => entry?.toolName).filter((name) => typeof name === "string" && name !== ""))].sort();
    const subject = names.length > 0 ? names.join(", ") : "a tool";
    const count = entries.length;
    const calls = count === 1 ? "1 tool call" : `${count} tool calls`;
    return (`A previous session left ${calls} unresolved (${subject}). ` +
        "Whether they ran cannot be determined, so they were not run again.");
}
/** One factual line when the journal file exists but cannot be trusted. */
export function formatCursorExecUnreadableNotice(reason) {
    if (typeof reason !== "string" || reason === "")
        return undefined;
    return (`A previous session's exec journal could not be read (${reason}). ` +
        "Tool execution is refused until the journal is recoverable or an operator resets it.");
}
/**
 * Replace the journal without ever leaving a partial file behind.
 *
 * Same shape as the auth store's atomic write, and for the same reason: the lock
 * serializes writers but does not protect the bytes of one write. An in-place
 * write truncates first, so a crash in that window leaves a file that parses as
 * nothing — erasing exactly the record that says a tool already ran.
 */
function atomicWriteJournalSync(journalPath, contents) {
    // Same directory as the target: rename is only atomic within one filesystem.
    const tempPath = join(dirname(journalPath), `.${CURSOR_EXEC_JOURNAL_FILE}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
        // wx = O_CREAT | O_EXCL | O_WRONLY. Two writers can never share a temp path.
        fd = openSync(tempPath, "wx", 0o600);
        // A short write is legal, not an error. Trusting one call silently truncates
        // the journal. Byte offsets, not string indices: a string index into UTF-8
        // output would resume mid-codepoint on any non-ASCII byte.
        const payload = Buffer.from(contents, "utf-8");
        let written = 0;
        while (written < payload.length) {
            const count = writeSync(fd, payload, written, payload.length - written);
            if (!(count > 0)) {
                throw new Error(`cursor exec journal write stalled after ${written} of ${payload.length} bytes`);
            }
            written += count;
        }
        // Force the bytes out before the rename publishes them.
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        // umask cannot loosen an explicit chmod, so assert the mode we promise.
        chmodSync(tempPath, 0o600);
        renameSync(tempPath, journalPath);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Closing failed on an already-failing path; the unlink below still runs.
            }
        }
        try {
            if (existsSync(tempPath))
                unlinkSync(tempPath);
        }
        catch {
            // Cleanup is best-effort: the original error is what the caller needs.
        }
        throw error;
    }
    // Directory fsync makes the rename itself durable across power loss. Not
    // best-effort: losing the rename means losing the record that a side effect
    // happened. POSIX (including macOS) allows fsyncing a read-only directory
    // handle; only Windows refuses, and only those errnos are tolerated.
    try {
        const dirFd = openSync(dirname(journalPath), "r");
        try {
            fsyncSync(dirFd);
        }
        finally {
            closeSync(dirFd);
        }
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
        const unsupported = process.platform === "win32" && (code === "EPERM" || code === "EISDIR" || code === "EACCES");
        if (!unsupported) {
            const reason = error instanceof Error ? error.message : String(error);
            const failure = new Error(`cursor exec journal replaced ${journalPath} but could not fsync its directory: ${reason}`);
            failure.cause = error;
            failure.journalFileReplaced = true;
            throw failure;
        }
    }
}
/** An empty journal. Used only when the file is genuinely absent. */
function emptyState() {
    return { version: CURSOR_EXEC_JOURNAL_VERSION, entries: {}, ledger: {} };
}
/**
 * Marker on an in-memory envelope for a journal we must not treat as empty.
 * Never serialized: withLock refuses to write an unreadable envelope back.
 */
const UNREADABLE = Symbol("cursor-exec-journal-unreadable");
function unreadableState(reason) {
    const state = emptyState();
    state[UNREADABLE] = reason;
    return state;
}
function unreadableReasonOf(state) {
    const reason = state?.[UNREADABLE];
    return typeof reason === "string" && reason !== "" ? reason : undefined;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse the journal, or refuse to guess.
 *
 * Absence is empty. A file that is present but unreadable, malformed, or from
 * an unknown version is **not** empty: treating it as empty discards the dedup
 * ledger and authorizes a completed tool call to run a second time. Row-level
 * dirt is still dropped; table-level dirt fails closed.
 */
function parseState(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, reason: "the exec journal is present but is not valid JSON" };
    }
    if (!isPlainObject(parsed))
        return { ok: false, reason: "the exec journal is present but is not a JSON object" };
    if (parsed.version !== CURSOR_EXEC_JOURNAL_VERSION) {
        return {
            ok: false,
            reason: `the exec journal is version ${String(parsed.version)}, which this process does not read`,
        };
    }
    if (parsed.entries !== undefined && !isPlainObject(parsed.entries)) {
        return { ok: false, reason: "the exec journal entries table is malformed" };
    }
    if (parsed.ledger !== undefined && !isPlainObject(parsed.ledger)) {
        return { ok: false, reason: "the exec journal ledger is malformed" };
    }
    const entries = parsed.entries ?? {};
    const clean = {};
    for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== "object" || value === null)
            continue;
        if (typeof value.state !== "string")
            continue;
        clean[key] = value;
    }
    // The ledger is the dedup identity, so a malformed row is dropped but a
    // malformed *table* must not quietly become "nothing ever ran".
    const rawLedger = parsed.ledger ?? {};
    const ledger = {};
    for (const [lineageId, record] of Object.entries(rawLedger)) {
        if (typeof record !== "object" || record === null)
            continue;
        const ids = typeof record.ids === "object" && record.ids !== null ? record.ids : {};
        const clean_ids = {};
        for (const [toolCallId, code] of Object.entries(ids)) {
            if (typeof code === "string" && code.length > 0)
                clean_ids[toolCallId] = code;
        }
        ledger[lineageId] = {
            updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
            ids: clean_ids,
        };
    }
    return { ok: true, state: { version: CURSOR_EXEC_JOURNAL_VERSION, entries: clean, ledger } };
}
/** Record dedup identity. Called on every state transition worth remembering. */
function rememberInLedger(state, lineageId, toolCallId, code, now) {
    const record = state.ledger[lineageId] ?? { updatedAt: 0, ids: {} };
    record.ids[toolCallId] = code;
    record.updatedAt = now;
    state.ledger[lineageId] = record;
}
function ledgerCodeOf(state, lineageId, toolCallId) {
    return state.ledger[lineageId]?.ids?.[toolCallId];
}
/**
 * The ledger code for a settled entry.
 *
 * A `failed` entry that never ran (`sideEffect: none`) is not the same fact as a
 * tool that ran and returned an error, and the difference survives here because
 * it is the difference between "nothing happened" and "something happened".
 */
function ledgerCodeForEntry(entry) {
    if (entry.state === CURSOR_EXEC_FAILED && entry.sideEffect === CURSOR_SIDE_EFFECT_NONE)
        return LEDGER_NOT_RUN;
    return LEDGER_CODE[entry.state] ?? LEDGER_UNKNOWN;
}
/**
 * Drop what a restart can no longer use: expired entries, then the oldest
 * terminal ones. Live entries (`prepared`/`executing`) are never pruned — they
 * are precisely the ones a restart must see in order to settle them.
 *
 * This prunes **rich records only**. The dedup ledger has its own, much longer
 * bound (`pruneLedger`): if this function could evict identity, a redelivered
 * frame past the cap would be read as new and the tool would run twice.
 */
function prune(state, now, maxEntries, ttlMs) {
    for (const [key, entry] of Object.entries(state.entries)) {
        if (!TERMINAL.has(entry.state))
            continue;
        const stamp = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
        if (now - stamp > ttlMs)
            delete state.entries[key];
    }
    const keys = Object.keys(state.entries);
    if (keys.length <= maxEntries)
        return;
    const terminal = keys
        .filter((key) => TERMINAL.has(state.entries[key].state))
        .sort((a, b) => (state.entries[a].updatedAt ?? 0) - (state.entries[b].updatedAt ?? 0));
    let excess = keys.length - maxEntries;
    for (const key of terminal) {
        if (excess <= 0)
            break;
        delete state.entries[key];
        excess -= 1;
    }
}
/**
 * Bound the dedup ledger. Whole lineages, oldest-touched first.
 *
 * Never partial within a lineage: half a conversation's identity is worse than
 * none, because it looks authoritative while silently permitting a repeat of the
 * half that was dropped. A lineage that has not been touched in
 * `ledgerTtlMs` is a conversation no server is going to redeliver a frame for.
 */
function pruneLedger(state, now, maxIds, ttlMs) {
    for (const [lineageId, record] of Object.entries(state.ledger)) {
        if (now - (record.updatedAt ?? 0) > ttlMs)
            delete state.ledger[lineageId];
    }
    const lineages = Object.entries(state.ledger).sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
    let total = lineages.reduce((sum, [, record]) => sum + Object.keys(record.ids).length, 0);
    for (const [lineageId, record] of lineages) {
        if (total <= maxIds)
            break;
        // Keep at least the most recently touched lineage regardless of size: the
        // live conversation's identity is the one that must not disappear.
        if (Object.keys(state.ledger).length <= 1)
            break;
        total -= Object.keys(record.ids).length;
        delete state.ledger[lineageId];
    }
}
/** Is the process that owns this entry still around? */
function ownerAlive(pid, self) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    if (pid === self)
        return true;
    try {
        // Signal 0 checks existence without delivering anything.
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means it exists and belongs to someone else.
        return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
    }
}
/**
 * The journal for one profile.
 *
 * Every mutation is one locked read-modify-write. A read outside the lock is
 * allowed to be stale, because a stale read never authorizes an execution: that
 * decision is made only inside `prepare`, under the lock.
 */
export function createCursorExecJournal(options = {}) {
    const journalPath = options.journalPath ?? cursorExecJournalPath(options.agentDir);
    const now = options.now ?? (() => Date.now());
    const maxEntries = options.maxEntries ?? CURSOR_EXEC_JOURNAL_MAX_ENTRIES;
    const ttlMs = options.ttlMs ?? CURSOR_EXEC_JOURNAL_TTL_MS;
    const isOwnerAlive = options.isOwnerAlive ?? ((pid) => ownerAlive(pid, options.pid ?? process.pid));
    const pid = options.pid ?? process.pid;
    const ledgerMaxIds = options.ledgerMaxIds ?? CURSOR_EXEC_LEDGER_MAX_IDS;
    const ledgerTtlMs = options.ledgerTtlMs ?? CURSOR_EXEC_LEDGER_TTL_MS;
    let settled = false;
    function ensureParentDir() {
        const dir = dirname(journalPath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    function acquireLockSyncWithRetry() {
        const maxAttempts = 60;
        const delayMs = 25;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return lockfile.lockSync(journalPath, { ...FILE_STORAGE_LOCK_OPTIONS });
            }
            catch (error) {
                const code = typeof error === "object" && error !== null && "code" in error
                    ? String(error.code)
                    : undefined;
                if (code !== "ELOCKED" || attempt === maxAttempts)
                    throw error;
                lastError = error;
                // Sleep the thread instead of spinning: a contended journal must not
                // burn a core per waiter (same root cause as the auth store's retry).
                const sleeper = new Int32Array(new SharedArrayBuffer(4));
                Atomics.wait(sleeper, 0, 0, delayMs);
            }
        }
        throw lastError ?? new Error("Failed to acquire cursor exec journal lock");
    }
    function readUnlocked() {
        if (!existsSync(journalPath))
            return emptyState();
        let raw;
        try {
            raw = readFileSync(journalPath, "utf-8");
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return unreadableState(`the exec journal exists but could not be read (${detail})`);
        }
        const parsed = parseState(raw);
        if (!parsed.ok)
            return unreadableState(parsed.reason);
        return parsed.state;
    }
    /** One locked read-modify-write. `fn` returns the value handed back. */
    function withLock(fn) {
        ensureParentDir();
        // proper-lockfile locks a sibling `.lock` directory, so the target need not
        // exist. Creating it up front would publish an empty journal on a pure read.
        let release;
        try {
            release = acquireLockSyncWithRetry();
            const state = readUnlocked();
            const sealed = unreadableReasonOf(state) !== undefined;
            let changed = false;
            const result = fn(state, () => {
                // A damaged file is not an empty journal. Overwriting it would hide
                // the only remaining bytes of identity. Operator reset is explicit.
                if (!sealed)
                    changed = true;
            });
            if (changed) {
                prune(state, now(), maxEntries, ttlMs);
                pruneLedger(state, now(), ledgerMaxIds, ledgerTtlMs);
                atomicWriteJournalSync(journalPath, JSON.stringify(state));
            }
            return result;
        }
        finally {
            if (release)
                release();
        }
    }
    /** Settle one mid-flight entry left by a process that is gone. */
    function settlement(entry, stamp) {
        if (entry.state === CURSOR_EXEC_PREPARED) {
            // The last durable write before the side effect had not happened yet, so
            // this is a fact, not a guess: nothing ran.
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
    /**
     * Settle what a previous process left mid-flight. Runs once, lazily, before
     * the first decision this process makes.
     *
     * Entries owned by a live process are left alone: another Rubato process on
     * this profile may be mid-execution right now, and settling its entry would
     * both lie about it and invite a duplicate run.
     */
    function settleStaleUnlocked(state, markChanged) {
        if (unreadableReasonOf(state) !== undefined)
            return [];
        const out = [];
        const stamp = now();
        for (const [key, entry] of Object.entries(state.entries)) {
            if (TERMINAL.has(entry.state))
                continue;
            if (isOwnerAlive(entry.pid))
                continue;
            state.entries[key] = { ...entry, ...settlement(entry, stamp), updatedAt: stamp };
            // Identity outlives the rich record, so it is written here too.
            rememberInLedger(state, entry.lineageId, entry.toolCallId, ledgerCodeForEntry(state.entries[key]), stamp);
            out.push(state.entries[key]);
            markChanged();
        }
        return out;
    }
    function settleStale() {
        return withLock((state, markChanged) => settleStaleUnlocked(state, markChanged));
    }
    function refuseUnreadable(lineageId, toolCallId, toolName, reason) {
        return {
            decision: "refuse",
            entry: {
                lineageId,
                toolCallId,
                toolName,
                state: CURSOR_EXEC_UNKNOWN,
                sideEffect: CURSOR_SIDE_EFFECT_UNKNOWN,
                reason,
            },
            reason,
        };
    }
    function ensureSettled() {
        if (settled)
            return [];
        settled = true;
        return settleStale();
    }
    return {
        path: journalPath,
        /** Settle mid-flight entries from dead processes. Idempotent per instance. */
        settleStale: () => ensureSettled(),
        /** Why this journal is sealed, or `undefined` if it is readable. */
        unreadableReason() {
            return withLock((state) => unreadableReasonOf(state));
        },
        /** Read one entry without deciding anything. */
        read(lineageId, toolCallId) {
            return withLock((state) => {
                if (unreadableReasonOf(state) !== undefined)
                    return undefined;
                return state.entries[entryKey(lineageId, toolCallId)];
            });
        },
        /** Every entry, for diagnostics and for surfacing `unknown` to the user. */
        list() {
            return withLock((state) => {
                if (unreadableReasonOf(state) !== undefined)
                    return [];
                return Object.values(state.entries);
            });
        },
        /** Entries the user must be told about: settled `unknown`. */
        unresolved() {
            return withLock((state) => {
                if (unreadableReasonOf(state) !== undefined)
                    return [];
                return Object.values(state.entries).filter((entry) => entry.state === CURSOR_EXEC_UNKNOWN);
            });
        },
        /**
         * Settle dead mid-flight entries and list unresolved ones in one lock.
         * Startup notice uses this so a crashed `executing` is visible without a
         * later tool call. Live-PID owners are left alone.
         */
        settleAndListUnresolved() {
            return withLock((state, markChanged) => {
                const reason = unreadableReasonOf(state);
                if (reason !== undefined) {
                    return { unreadable: true, reason, settled: [], unresolved: [] };
                }
                const settled = settleStaleUnlocked(state, markChanged);
                const unresolved = Object.values(state.entries).filter((entry) => entry.state === CURSOR_EXEC_UNKNOWN);
                return { unreadable: false, settled, unresolved };
            });
        },
        /**
         * Explicit operator reset of a damaged journal. Quarantines the existing
         * bytes (never overwrites them in place) and publishes an empty journal.
         * A parse failure never does this on its own.
         */
        resetUnreadable({ confirm } = {}) {
            if (confirm !== "reset-unreadable-journal") {
                return {
                    reset: false,
                    reason: 'resetUnreadable requires confirm: "reset-unreadable-journal"',
                };
            }
            ensureParentDir();
            let release;
            try {
                release = acquireLockSyncWithRetry();
                const state = readUnlocked();
                const reason = unreadableReasonOf(state);
                if (reason === undefined) {
                    return { reset: false, reason: "journal is readable; refusing to reset" };
                }
                let quarantinedPath;
                if (existsSync(journalPath)) {
                    // Copy first. Renaming away then writing empty would, if we died
                    // between the two, look like an absent journal and authorize a
                    // duplicate run of whatever the damaged file had recorded.
                    quarantinedPath = `${journalPath}.unreadable.${now()}`;
                    copyFileSync(journalPath, quarantinedPath);
                    chmodSync(quarantinedPath, 0o600);
                }
                atomicWriteJournalSync(journalPath, JSON.stringify(emptyState()));
                settled = false;
                return { reset: true, quarantinedPath, reason };
            }
            finally {
                if (release)
                    release();
            }
        },
        /**
         * Decide whether this `{lineageId, toolCallId}` may execute, and record the
         * decision durably before returning. This is the only authorization point.
         *
         * - no entry and no ledger row → `execute`, recorded as `prepared`.
         * - terminal with a persisted result → `replay`, never a second run.
         * - a ledger row with no rich record → `refuse`. The rich record aged out,
         *   but identity says this key already ran, so it must not run again.
         * - terminal without a persisted result (`unknown`, or a settled `prepared`)
         *   → `refuse`, unless a caller **outside this journal** authorized a retry
         *   of this exact `toolCallId` and the tool declared a matching key.
         * - live entry owned by any process → `refuse`. Two runs must not drive the
         *   same call concurrently.
         * - journal present but unreadable / malformed / unknown version → `refuse`
         *   for every lineage. The file is the whole identity store; guessing which
         *   lineages are empty would re-authorize a completed call.
         */
        prepare({ lineageId, toolCallId, toolName, idempotencyKey, retryAuthorization }) {
            ensureSettled();
            return withLock((state, markChanged) => {
                const sealed = unreadableReasonOf(state);
                if (sealed !== undefined) {
                    return refuseUnreadable(lineageId, toolCallId, toolName,
                        `${sealed}; tool execution is refused until the journal is recoverable or an operator resets it`);
                }
                const key = entryKey(lineageId, toolCallId);
                const stamp = now();
                const write = (entry) => {
                    state.entries[key] = entry;
                    markChanged();
                    return entry;
                };
                /**
                 * A terminal entry with no persisted result.
                 *
                 * Re-running requires **two independent things**, and conflating them
                 * was a defect: a tool advertising `idempotencyKeyFor` would let an
                 * ordinary server redelivery silently re-run a side effect whose
                 * outcome was unknowable.
                 *
                 * 1. The tool declares an idempotency key matching the recorded one.
                 *    This only establishes that a retry *could* be safe. A tool
                 *    describing itself is not a request.
                 * 2. A caller outside this journal authorizes a retry of this exact
                 *    `toolCallId`. That is the user or the agent loop asking, and it
                 *    is the only thing that can turn `unknown` back into work.
                 *
                 * Absent (2), `unknown` refuses exactly as a non-idempotent tool does.
                 */
                const retryOrRefuse = (entry) => {
                    const declaredKeyMatches = typeof idempotencyKey === "string" && idempotencyKey !== "" && entry.idempotencyKey === idempotencyKey;
                    const authorized = retryAuthorization !== undefined
                        && retryAuthorization !== null
                        && retryAuthorization.toolCallId === toolCallId
                        && (retryAuthorization.idempotencyKey === undefined
                            || retryAuthorization.idempotencyKey === entry.idempotencyKey);
                    if (declaredKeyMatches && authorized) {
                        const next = write({
                            ...entry,
                            state: CURSOR_EXEC_PREPARED,
                            pid,
                            attempt: (typeof entry.attempt === "number" ? entry.attempt : 1) + 1,
                            retriedFrom: entry.state,
                            // The authorization is spent. A second redelivery of the same
                            // frame is a new question and needs a new answer, so nothing
                            // here may make the *next* prepare self-authorizing.
                            retryAuthorizedBy: retryAuthorization.actor ?? "caller",
                            settledFrom: undefined,
                            sideEffect: undefined,
                            reason: undefined,
                            settledAt: undefined,
                            updatedAt: stamp,
                        });
                        return { decision: "execute", entry: next };
                    }
                    const base = entry.reason
                        ?? (entry.state === CURSOR_EXEC_UNKNOWN
                            ? "the previous attempt's outcome is unknown"
                            : `the previous attempt ${entry.state}`);
                    return {
                        decision: "refuse",
                        entry,
                        reason: declaredKeyMatches && !authorized
                            ? `${base}; the tool permits retry but no caller authorized one`
                            : base,
                    };
                };
                const existing = state.entries[key];
                if (existing === undefined) {
                    // No rich record. Identity is the authority here, and it is retained
                    // far longer, so a repeat past the entry cap is still caught.
                    const code = ledgerCodeOf(state, lineageId, toolCallId);
                    if (code !== undefined) {
                        const synthetic = {
                            lineageId,
                            toolCallId,
                            toolName,
                            state: code === LEDGER_UNKNOWN
                                ? CURSOR_EXEC_UNKNOWN
                                : code === LEDGER_COMPLETED
                                    ? CURSOR_EXEC_COMPLETED
                                    : CURSOR_EXEC_FAILED,
                            sideEffect: LEDGER_SIDE_EFFECT[code] ?? CURSOR_SIDE_EFFECT_UNKNOWN,
                            reason: LEDGER_REASON[code] ?? "this tool call was already recorded",
                            recordEvicted: true,
                        };
                        // No `resultPersisted`, so this can never become a `replay`: the
                        // payload is gone. Refusing is the only honest answer, and it is
                        // still exactly-once — the tool does not run a second time.
                        return retryOrRefuse(synthetic);
                    }
                    rememberInLedger(state, lineageId, toolCallId, LEDGER_NOT_RUN, stamp);
                    return {
                        decision: "execute",
                        entry: write({
                            lineageId,
                            toolCallId,
                            toolName,
                            state: CURSOR_EXEC_PREPARED,
                            pid,
                            attempt: 1,
                            idempotencyKey,
                            createdAt: stamp,
                            updatedAt: stamp,
                        }),
                    };
                }
                if (existing.resultPersisted === true) {
                    // The authoritative case the design names: `completed` (or `failed`)
                    // together with a persisted result means never execute again.
                    return { decision: "replay", entry: existing };
                }
                if (!TERMINAL.has(existing.state)) {
                    if (isOwnerAlive(existing.pid)) {
                        return {
                            decision: "refuse",
                            entry: existing,
                            reason: existing.pid === pid
                                ? `tool call ${toolCallId} is already ${existing.state} in this process`
                                : `tool call ${toolCallId} is ${existing.state} in process ${existing.pid}`,
                        };
                    }
                    // Owner is gone. Settle it now rather than reading a state no live
                    // process stands behind, then apply the terminal rule to the result.
                    const settledEntry = write({ ...existing, ...settlement(existing, stamp), updatedAt: stamp });
                    rememberInLedger(state, lineageId, toolCallId, ledgerCodeForEntry(settledEntry), stamp);
                    return retryOrRefuse(settledEntry);
                }
                return retryOrRefuse(existing);
            });
        },
        /**
         * The last durable write before the side effect. A process killed from here
         * until `complete` is exactly the case that settles to `unknown`.
         */
        markExecuting(lineageId, toolCallId) {
            return withLock((state, markChanged) => {
                const key = entryKey(lineageId, toolCallId);
                const entry = state.entries[key];
                if (entry === undefined)
                    return undefined;
                const stamp = now();
                state.entries[key] = {
                    ...entry,
                    state: CURSOR_EXEC_EXECUTING,
                    pid,
                    executingAt: stamp,
                    updatedAt: stamp,
                };
                markChanged();
                return state.entries[key];
            });
        },
        /**
         * The side effect is over and this is its result. State and result land in
         * one atomic write, because "completed plus a persisted tool result" is the
         * single fact that licenses replay — splitting it would create a window
         * where a succeeded turn has to be reported as `unknown`.
         *
         * `isError` distinguishes `failed` from `completed`. Both are replayable:
         * an error result is still the answer to that exec frame, and re-running a
         * tool to reproduce a failure is a second side effect.
         */
        complete(lineageId, toolCallId, { isError = false, result, summary } = {}) {
            return withLock((state, markChanged) => {
                const key = entryKey(lineageId, toolCallId);
                const entry = state.entries[key];
                if (entry === undefined)
                    return undefined;
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
                    resultPersistedAt: stamp,
                    updatedAt: stamp,
                };
                // Identity is recorded alongside, under the same lock and the same
                // atomic write, so it can never disagree with the rich record.
                rememberInLedger(state, lineageId, toolCallId, ledgerCodeForEntry(state.entries[key]), stamp);
                markChanged();
                return state.entries[key];
            });
        },
        /**
         * The host transcript now holds the result too.
         *
         * Bookkeeping only: replay is already licensed by `complete`, so losing
         * this write costs nothing but a diagnostic. It exists so a restart can
         * tell "the journal answered for it" from "the transcript already had it".
         */
        markResultDelivered(lineageId, toolCallId) {
            return withLock((state, markChanged) => {
                const key = entryKey(lineageId, toolCallId);
                const entry = state.entries[key];
                if (entry === undefined)
                    return undefined;
                const stamp = now();
                state.entries[key] = { ...entry, resultDelivered: true, resultDeliveredAt: stamp, updatedAt: stamp };
                markChanged();
                return state.entries[key];
            });
        },
        /**
         * Forget the rich records of one lineage. Used when a session is disposed.
         *
         * The dedup ledger for that lineage is **kept**. Disposing a session frees
         * diagnostics; it does not make it safe to run its tool calls again, and a
         * straggler frame from a disposed session's still-open stream is exactly the
         * case that would otherwise execute a second time.
         */
        forgetLineage(lineageId) {
            return withLock((state, markChanged) => {
                let removed = 0;
                for (const [key, entry] of Object.entries(state.entries)) {
                    if (entry.lineageId !== lineageId)
                        continue;
                    delete state.entries[key];
                    removed += 1;
                }
                if (removed > 0)
                    markChanged();
                return removed;
            });
        },
        /**
         * Drop a lineage's dedup identity as well. Separate from `forgetLineage`
         * because it is the one operation that re-permits execution, so it cannot be
         * something a routine session teardown does by accident.
         */
        forgetLineageIdentity(lineageId) {
            return withLock((state, markChanged) => {
                if (state.ledger[lineageId] === undefined)
                    return false;
                delete state.ledger[lineageId];
                markChanged();
                return true;
            });
        },
        /** Ledger size, for tests and diagnostics. Does not expose ids. */
        ledgerStats() {
            return withLock((state) => {
                const lineages = Object.keys(state.ledger).length;
                let ids = 0;
                for (const record of Object.values(state.ledger))
                    ids += Object.keys(record.ids).length;
                return { lineages, ids, entries: Object.keys(state.entries).length };
            });
        },
    };
}
