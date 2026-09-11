import { createHash } from "node:crypto";

export const DEFAULT_POOL_AFFINITY_KEY = "credential-pool-default";

export class AllSlotsBlockedError extends Error {
  constructor(soonestUnblockAt) {
    super(soonestUnblockAt === undefined
      ? "All credential slots are blocked until re-login."
      : `All credential slots are blocked until ${new Date(soonestUnblockAt).toISOString()}.`);
    this.name = "AllSlotsBlockedError";
    this.soonestUnblockAt = soonestUnblockAt;
  }
}

export function sha256SlotHasher(input) {
  return createHash("sha256").update(input).digest().readBigUInt64BE(0);
}

export function getPoolAffinityKey(options) {
  return options.affinityKey ?? options.sessionId ?? DEFAULT_POOL_AFFINITY_KEY;
}

export function rendezvousOrder(key, slots, hasher) {
  return [...slots]
    .map((slot) => ({ slot, score: hasher(`${key}\0${slot.name}`) }))
    .sort((left, right) => (right.score > left.score ? 1 : right.score < left.score ? -1 : 0))
    .map(({ slot }) => slot);
}

function isBlocked(slot, now) {
  return slot.blockReason === "auth_error" || (slot.blockedUntil !== undefined && slot.blockedUntil > now);
}

export function clearExpiredSlotBlocks(slots, now = Date.now()) {
  return slots.map((slot) => {
    if (slot.blockReason !== "auth_error" && slot.blockedUntil !== undefined && slot.blockedUntil <= now) {
      const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = slot;
      return available;
    }
    return slot;
  });
}

function selectUnblocked(slots, options, now) {
  const pinned = options.pinnedSlot === undefined ? undefined : slots.find((slot) => slot.name === options.pinnedSlot);
  if (pinned && !isBlocked(pinned, now)) return pinned;
  return rendezvousOrder(getPoolAffinityKey(options), slots, options.hasher).find((slot) => !isBlocked(slot, now));
}

function soonestUnblockAt(slots, now) {
  const candidates = slots
    .map((slot) => slot.blockedUntil)
    .filter((value) => value !== undefined && value > now);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

export function selectSlot(slots, options) {
  const now = options.now ?? Date.now();
  const selected = selectUnblocked(slots, options, now);
  if (selected) return selected;
  const cleared = clearExpiredSlotBlocks(slots, now);
  const retried = selectUnblocked(cleared, { ...options, now }, now);
  const original = retried === undefined ? undefined : slots.find((slot) => slot.name === retried.name);
  if (original) return original;
  throw new AllSlotsBlockedError(soonestUnblockAt(slots, now));
}
