export function sessionAffinityStore(runtime) {
  return runtime._rubatoSessionAffinity ?? (runtime._rubatoSessionAffinity = new Map());
}

export function affinityStoreKey(providerId, affinityKey) {
  return `${providerId}\0${affinityKey}`;
}

export function boundSessionSlot(store, providerId, affinityKey) {
  if (!store || affinityKey === undefined) return undefined;
  return store.get(affinityStoreKey(providerId, affinityKey));
}

export function bindSessionSlot(store, providerId, affinityKey, slot) {
  if (!store || affinityKey === undefined || !slot?.name) return slot;
  store.set(affinityStoreKey(providerId, affinityKey), { name: slot.name, lane: slot.lane });
  return slot;
}

export async function readSessionBinding(store, repository, providerId, sessionId) {
  const memory = boundSessionSlot(store, providerId, sessionId);
  if (memory || sessionId === undefined) return memory;
  const saved = await repository.sessionBinding(providerId, sessionId);
  if (saved) bindSessionSlot(store, providerId, sessionId, saved);
  return saved;
}
