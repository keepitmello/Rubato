import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CREDENTIAL_POOL_STATE_FILENAME = "credential-pool-state.json";
const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 };

function freshDocument() {
  return { schemaVersion: 1, installationKey: randomBytes(32).toString("hex"), providers: {} };
}

function parseDocument(content) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.installationKey !== "string" || typeof parsed.providers !== "object") {
      return freshDocument();
    }
    return parsed;
  } catch {
    return freshDocument();
  }
}

export function slotHealth(state, now) {
  if (!state) return "ready";
  if (state.blockReason === "auth_error" || state.blockReason === "account_disabled") return "blocked";
  if (state.blockedUntil !== undefined && state.blockedUntil > now) return "blocked";
  if (state.blockedUntil !== undefined && state.lease !== undefined && state.lease.expiresAt > now) return "half_open";
  return "ready";
}

async function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`credential-pool-state lock timeout: ${lockPath}`);
}

export class CredentialSlotRepository {
  constructor(path) {
    this.path = path;
    this.memory = path ? undefined : freshDocument();
  }

  async withDocument(fn) {
    if (!this.path) {
      const { result, next } = fn(this.memory);
      if (next) this.memory = next;
      return result;
    }
    const lockPath = `${this.path}.lock`;
    const fd = await acquireLock(lockPath);
    try {
      const current = existsSync(this.path) ? parseDocument(readFileSync(this.path, "utf-8")) : freshDocument();
      const { result, next } = fn(current);
      if (next) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        writeFileSync(this.path, JSON.stringify(next, null, 2), FILE_WRITE_OPTIONS);
      }
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }

  async installationKey() {
    return this.withDocument((document) => ({ result: document.installationKey, next: document }));
  }

  async envCredentialRevision(envVarName, envValue) {
    const key = await this.installationKey();
    return createHmac("sha256", key).update(`${envVarName}\0${envValue}`).digest("hex");
  }

  async listSlots(providerId, laneId) {
    return this.withDocument((document) => ({
      result: { ...(document.providers[providerId]?.lanes?.[laneId]?.slots ?? {}) },
    }));
  }

  async mutateSlotState(providerId, laneId, slotId, fn) {
    return this.withDocument((document) => {
      const provider = document.providers[providerId] ?? { lanes: {} };
      const lane = provider.lanes[laneId] ?? { slots: {} };
      const current = lane.slots[slotId];
      const mutated = fn(current);
      const slots = { ...lane.slots };
      let result;
      if (mutated === undefined) {
        delete slots[slotId];
      } else {
        result = { ...mutated, stateVersion: (current?.stateVersion ?? 0) + 1 };
        slots[slotId] = result;
      }
      const next = {
        ...document,
        providers: {
          ...document.providers,
          [providerId]: { lanes: { ...provider.lanes, [laneId]: { slots } } },
        },
      };
      return { result, next };
    });
  }
}

export async function acquireHalfOpenLease(repository, providerId, laneId, slotId, options = {}) {
  const now = options.now ?? Date.now();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  let lease;
  await repository.mutateSlotState(providerId, laneId, slotId, (current) => {
    if (!current) return current;
    const expired = current.blockedUntil !== undefined && current.blockedUntil <= now;
    const leaseLive = current.lease !== undefined && current.lease.expiresAt > now;
    if (!expired || leaseLive || current.blockReason === "auth_error") return current;
    lease = { leaseId: randomUUID(), expiresAt: now + leaseTtlMs };
    return { ...current, lease: { id: lease.leaseId, expiresAt: lease.expiresAt } };
  });
  return lease;
}
