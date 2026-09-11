export const DEFAULT_SLOT_NAME = "default";
const SLOT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidSlotName(name) {
  if (!SLOT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`);
  }
}

function storedSlots(credential) {
  return Array.isArray(credential.accounts) ? credential.accounts : [];
}

function slotFromFlatCredential(credential) {
  if (credential.type === "oauth") {
    return {
      name: DEFAULT_SLOT_NAME,
      source: "login",
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
    };
  }
  return { name: DEFAULT_SLOT_NAME, source: "login", key: credential.key };
}

export function listSlots(credential) {
  if (!credential) return [];
  const slots = storedSlots(credential);
  return slots.length > 0 ? [...slots] : [slotFromFlatCredential(credential)];
}

export function findSlot(credential, name) {
  return listSlots(credential).find((slot) => slot.name === name);
}

export function upsertSlot(credential, slot) {
  assertValidSlotName(slot.name);
  const base = credential ??
    (slot.access !== undefined || slot.refresh !== undefined
      ? { type: "oauth", access: slot.access ?? "", refresh: slot.refresh ?? "", expires: slot.expires ?? 0 }
      : { type: "api_key", key: slot.key });
  const existing = listSlots(base);
  const index = existing.findIndex((candidate) => candidate.name === slot.name);
  const accounts = index >= 0
    ? existing.map((candidate) => (candidate.name === slot.name ? { ...candidate, ...slot } : candidate))
    : [...existing, slot];
  return { ...base, accounts };
}

function slotMirrorsFlat(credential, slot) {
  if (credential.type === "oauth") return slot.access === credential.access || slot.refresh === credential.refresh;
  return slot.key === credential.key;
}

function projectFlatFields(credential, slot) {
  if (credential.type === "oauth") {
    if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return credential;
    return { ...credential, access: slot.access, refresh: slot.refresh, expires: slot.expires };
  }
  return { ...credential, key: slot.key };
}

export function removeSlot(credential, name) {
  if (!credential) return undefined;
  const existing = listSlots(credential);
  const removed = existing.find((slot) => slot.name === name);
  const accounts = existing.filter((slot) => slot.name !== name);
  if (accounts.length === 0) return undefined;
  const reprojected = removed && slotMirrorsFlat(credential, removed) ? projectFlatFields(credential, accounts[0]) : credential;
  const next = { ...reprojected, accounts };
  if (next.pinned === name) delete next.pinned;
  return next;
}

export function pinSlot(credential, name) {
  assertValidSlotName(name);
  return { ...credential, pinned: name };
}

export function projectSlot(credential, name) {
  if (!credential) return undefined;
  const slot = findSlot(credential, name);
  if (!slot) return undefined;
  const { accounts: _accounts, pinned: _pinned, ...flat } = credential;
  if (flat.type === "oauth") {
    if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return undefined;
    return { ...flat, access: slot.access, refresh: slot.refresh, expires: slot.expires };
  }
  return { ...flat, key: slot.key };
}

function slotFromFlatCredentialNamed(credential, name) {
  if (credential.type === "oauth") {
    return {
      name,
      source: "login",
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
    };
  }
  return { name, source: "login", key: credential.key };
}

function nextLoginSlotName(credential) {
  const taken = new Set(listSlots(credential).map((slot) => slot.name));
  for (let index = 2; index < 1000; index++) {
    const candidate = `login-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Credential pool is full");
}

export function appendLoginSlot(current, flat) {
  if ("accounts" in flat && Array.isArray(flat.accounts) && flat.accounts.length > 0) return flat;
  if (!current) return flat;
  return upsertSlot(current, slotFromFlatCredentialNamed(flat, nextLoginSlotName(current)));
}

export function mergeRefreshedSlot(current, name, refreshed) {
  if (refreshed.type !== "oauth" || current.type !== "oauth") return current;
  if (name == null || name === "") return mergeRefreshed(current, refreshed);
  if (!Array.isArray(current.accounts) || current.accounts.length === 0) return mergeRefreshed(current, refreshed);
  const target = current.accounts.find((slot) => slot.name === name);
  if (!target) {
    throw new Error(`Cannot merge refreshed OAuth into missing credential slot '${name}'`);
  }
  const rotated = { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
  const accounts = current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot));
  const mirrorsFlat = target.access === current.access || target.refresh === current.refresh;
  return mirrorsFlat ? { ...current, ...rotated, accounts } : { ...current, accounts };
}

export function mergeRefreshed(current, refreshed) {
  if (!Array.isArray(current.accounts) || current.accounts.length === 0) return refreshed;
  if (refreshed.type !== "oauth" || current.type !== "oauth") return refreshed;
  const target = current.accounts.find((slot) => slot.access === current.access || slot.refresh === current.refresh);
  const rotated = { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
  const accounts = target
    ? current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot))
    : current.accounts;
  return { ...current, ...rotated, accounts };
}
