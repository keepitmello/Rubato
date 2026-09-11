import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export const MAX_CURSOR_CONVERSATION_ROTATIONS = 3;
export const MAX_CURSOR_CONVERSATION_ROTATION_RECORDS = 512;
export const CURSOR_CONVERSATION_POISONED_MESSAGE = "Cursor conversation is poisoned for this session; use another provider";
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;
export function isZeroTokenResourceExhausted(errorMessage, sawTokenDelta) {
    return !sawTokenDelta && RESOURCE_EXHAUSTED_PATTERN.test(errorMessage);
}
export function createConversationRotationStore(options) {
    const randomId = options.randomId ?? randomUUID;
    const maxRecords = options.maxRecords ??
        readRotationRecordLimit(process.env.PI_CURSOR_ROTATION_RECORD_LIMIT) ??
        MAX_CURSOR_CONVERSATION_ROTATION_RECORDS;
    const records = loadRecords(options.persistPath);
    // #1024: records accumulate one per base conversation id for process
    // lifetime (and each persist rewrites the whole file). Object key order is
    // insertion order for these uuid-shaped ids, so the oldest records drop
    // first. Poison memory survives process restarts via the persisted file;
    // trimming only forgets the oldest ids, which re-derive cheaply (at most a
    // surfaced 0-token RE per id).
    const trimRecords = () => {
        const keys = Object.keys(records);
        for (let i = 0; i < keys.length - maxRecords; i++)
            delete records[keys[i]];
    };
    const persist = () => {
        trimRecords();
        mkdirSync(dirname(options.persistPath), { recursive: true });
        writeFileSync(options.persistPath, `${JSON.stringify(records, null, 2)}\n`);
    };
    return {
        getWireId(baseId) {
            const existing = records[baseId];
            if (!existing)
                return baseId;
            if (!existing.skip)
                return existing.wireId;
            const wireId = randomId();
            existing.wireId = wireId;
            existing.skip = false;
            existing.poisonCount = 0;
            // A reminted id is a fresh conversation: it earns its own surface-first
            // pass so compaction runs again before rotation resumes.
            existing.surfaced = false;
            records[baseId] = existing;
            persist();
            return wireId;
        },
        shouldSkip(baseId) {
            return records[baseId]?.skip === true;
        },
        shouldSurfaceBeforeRotating(baseId) {
            return records[baseId]?.surfaced !== true;
        },
        markSurfaced(baseId, currentWireId) {
            const existing = records[baseId] ?? {
                wireId: currentWireId,
                poisonCount: 0,
                skip: false,
                surfaced: false,
            };
            if (existing.surfaced)
                return;
            existing.surfaced = true;
            records[baseId] = existing;
            persist();
        },
        recordCount() {
            return Object.keys(records).length;
        },
        recordZeroTokenPoison(baseId, currentWireId) {
            const existing = records[baseId] ?? {
                wireId: currentWireId,
                poisonCount: 0,
                skip: false,
                surfaced: false,
            };
            if (existing.skip || existing.poisonCount >= MAX_CURSOR_CONVERSATION_ROTATIONS) {
                existing.skip = true;
                existing.wireId = currentWireId;
                records[baseId] = existing;
                persist();
                return { kind: "exhausted" };
            }
            const wireId = randomId();
            existing.wireId = wireId;
            existing.poisonCount += 1;
            records[baseId] = existing;
            persist();
            return { kind: "rotated", wireId };
        },
        /**
         * Drop the rotation record for a disposed conversation lineage.
         *
         * Without this the store keeps one entry per base conversation for the life
         * of the persist file, and the session-disposal cleanup below cannot finish
         * the job: the state caches would be freed while the rotation record that
         * points at their wire id stays behind forever.
         *
         * Poison handling is unchanged for live conversations. Forgetting a disposed
         * lineage is not the same as clearing poison: a later conversation reusing
         * the same base id is a genuinely new conversation and earns its own
         * surface-first pass, which is what a missing record already means.
         */
        forget(baseId) {
            if (!(baseId in records))
                return false;
            delete records[baseId];
            persist();
            return true;
        },
    };
}
export function resolveConversationRotationPersistPath(env = process.env) {
    if (env.CURSOR_CONVERSATION_ID_STORE) {
        return env.CURSOR_CONVERSATION_ID_STORE;
    }
    const agentDir = env.SENPI_CODING_AGENT_DIR ?? env.CODING_AGENT_DIR ?? `${(env.HOME ?? ".").replace(/\/$/, "")}/.senpi/agent`;
    return `${agentDir.replace(/\/$/, "")}/cursor-conversation-ids.json`;
}
function readRotationRecordLimit(raw) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
function loadRecords(persistPath) {
    try {
        const parsed = JSON.parse(readFileSync(persistPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        const records = {};
        for (const [baseId, value] of Object.entries(parsed)) {
            if (!value || typeof value !== "object")
                continue;
            const raw = value;
            if (typeof raw.wireId !== "string" || raw.wireId.length === 0)
                continue;
            records[baseId] = {
                wireId: raw.wireId,
                poisonCount: typeof raw.poisonCount === "number" && raw.poisonCount >= 0 ? raw.poisonCount : 0,
                skip: raw.skip === true,
                surfaced: raw.surfaced === true,
            };
        }
        return records;
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=cursor-conversation-rotation.js.map