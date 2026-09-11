import { randomUUID } from "node:crypto";
import { rendezvousOrder, sha256SlotHasher } from "./select.mjs";
import { listSlots as listCredentialSlots } from "./slots.mjs";
import { classifyCredentialFailure } from "./classify.mjs";
import { discoverEnvSlots } from "./env-slots.mjs";
import { runCredentialFailover } from "./failover.mjs";
import { acquireHalfOpenLease } from "./state-store.mjs";

function overlayState(slot, state) {
  if (!state) return slot;
  return {
    ...slot,
    ...(state.blockedUntil === undefined ? {} : { blockedUntil: state.blockedUntil }),
    ...(state.blockReason === undefined ? {} : { blockReason: state.blockReason }),
    ...(state.failureCount === undefined ? {} : { failureCount: state.failureCount }),
    ...(state.lease === undefined ? {} : { lease: state.lease }),
  };
}

export async function listRotationSlots(sources, options = {}) {
  const acquireLeases = options.acquireLeases !== false;
  const { providerId, credential, env, repository } = sources;
  const policySlots = Object.entries(sources.policy?.slots ?? {}).flatMap(([name, ref]) => {
    const envVarName = ref.env ?? `models.json:${name}`;
    const key = ref.env !== undefined ? env(ref.env) : ref.value;
    if (!key) return [];
    return [{ name, envVarName, key, source: "env" }];
  });
  if (credential) {
    const state = await repository.listSlots(providerId, "stored");
    const slots = [];
    for (const slot of listCredentialSlots(credential)) {
      const current = state[slot.name];
      if (acquireLeases && current?.blockedUntil !== undefined && current.blockedUntil <= (sources.now ?? Date.now)()) {
        const lease = await acquireHalfOpenLease(repository, providerId, "stored", slot.name, {
          now: (sources.now ?? Date.now)(),
        });
        if (!lease) continue;
        const leased = await repository.listSlots(providerId, "stored");
        slots.push(overlayState({ name: slot.name, lane: "stored", pinned: credential.pinned === slot.name }, leased[slot.name]));
        continue;
      }
      slots.push(overlayState({ name: slot.name, lane: "stored", pinned: credential.pinned === slot.name }, current));
    }
    if (policySlots.length === 0) return slots;
    const namedSlots = await listEnvRotationSlots({ ...sources, credential: undefined, policy: { ...sources.policy, slots: {} } }, policySlots, acquireLeases);
    return [...slots, ...namedSlots];
  }
  const envSlots = [...discoverEnvSlots(providerId, env), ...policySlots];
  return listEnvRotationSlots(sources, envSlots, acquireLeases);
}

async function listEnvRotationSlots(sources, envSlots, acquireLeases = true) {
  if (envSlots.length === 0) return [];
  const { providerId, repository } = sources;
  const state = await repository.listSlots(providerId, "env");
  const slots = [];
  for (const slot of envSlots) {
    const persisted = state[slot.name];
    const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
    let applicable = persisted?.credentialRevision === revision ? persisted : undefined;
    if (acquireLeases && applicable?.blockedUntil !== undefined && applicable.blockedUntil <= (sources.now ?? Date.now)()) {
      const lease = await acquireHalfOpenLease(repository, providerId, "env", slot.name, {
        now: (sources.now ?? Date.now)(),
      });
      if (!lease) continue;
      const leased = await repository.listSlots(providerId, "env");
      applicable = leased[slot.name];
    }
    slots.push(overlayState({
      name: slot.name,
      lane: "env",
      envKey: slot.key,
      envVarName: slot.envVarName,
    }, applicable));
  }
  return slots;
}

function blockPatch(block, current, now, credentialRevision, policy) {
  const failureCount = (current?.failureCount ?? 0) + 1;
  const base = {
    failureCount,
    ...(credentialRevision === undefined ? {} : { credentialRevision }),
    ...(current?.lastSuccessAt === undefined ? {} : { lastSuccessAt: current.lastSuccessAt }),
  };
  if (block.reason === "rate_limit") {
    return {
      ...base,
      blockedUntil: now + Math.min(policy?.cooldownCapMs ?? block.cooldownMs, block.cooldownMs),
      blockReason: "rate_limit",
    };
  }
  return { ...base, blockReason: block.reason };
}

function errorFromEvent(event) {
  if (event.type !== "error") return undefined;
  const message = event.error?.errorMessage ?? event.error?.message ?? "provider stream error";
  const failure = new Error(message);
  if (typeof event.error?.status === "number") failure.status = event.error.status;
  return failure;
}

export function streamWithCredentialRotation(options) {
  const { sources, runAttempt } = options;
  const hasher = options.hasher ?? sha256SlotHasher;
  const affinityKey = options.affinityKey ?? randomUUID();
  const useAffinity = sources.policy?.affinity !== false;
  const now = sources.now ?? Date.now;
  return runCredentialFailover({
    listSlots: () => listRotationSlots(sources),
    select: (candidates) => {
      const pinned = candidates.find((candidate) => candidate.pinned === true);
      if (pinned) return pinned;
      const ordered = useAffinity ? rendezvousOrder(affinityKey, candidates, hasher) : candidates;
      const winner = ordered[0];
      if (!winner) throw new Error("credential rotation selected from an empty candidate set");
      return winner;
    },
    runAttempt,
    isCommittedOutput: (event) => event.type !== "start",
    errorFromEvent,
    classify: (error, context) => classifyCredentialFailure(error, {
      ...context,
      cooldownBaseMs: sources.policy?.cooldownBaseMs,
      cooldownCapMs: sources.policy?.cooldownCapMs,
    }),
    onSuccess: async (slot) => {
      await sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) => current
        ? { ...current, lastSuccessAt: now(), lease: undefined, blockedUntil: undefined, blockReason: undefined }
        : undefined);
    },
    persistBlock: async (slot, block) => {
      const revision = slot.lane === "env" && slot.envVarName !== undefined && slot.envKey !== undefined
        ? await sources.repository.envCredentialRevision(slot.envVarName, slot.envKey)
        : undefined;
      await sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) =>
        blockPatch(block, current, now(), revision, sources.policy));
    },
    now,
  });
}
