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
  if (!taken.has("sub")) return "sub";
  for (let index = 2; index < 1000; index++) {
    const candidate = `login-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Credential pool is full");
}

function decodeJwtClaims(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof Buffer === "function"
      ? Buffer.from(payload, "base64").toString("utf8")
      : atob(payload + "=".repeat((4 - (payload.length % 4)) % 4));
    const claims = JSON.parse(json);
    return claims !== null && typeof claims === "object" ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who a credential belongs to, when the credential says so. API keys are their own identity;
 * OAuth access tokens carry an issuer/subject pair when they are JWTs. Opaque tokens (Anthropic)
 * return undefined — unknown, never "same".
 */
export function loginAccountIdentity(source) {
  if (typeof source?.key === "string" && source.key.length > 0) return `key:${source.key}`;
  const claims = decodeJwtClaims(source?.access);
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  if (subject.length === 0) return undefined;
  return `oauth:${typeof claims.iss === "string" ? claims.iss : ""}:${subject}`;
}

export function appendLoginSlot(current, flat) {
  if ("accounts" in flat && Array.isArray(flat.accounts) && flat.accounts.length > 0) return flat;
  if (!current) return flat;
  const incoming = loginAccountIdentity(flat);
  const existing = incoming === undefined
    ? undefined
    : listSlots(current).find((slot) => loginAccountIdentity(slot) === incoming);
  if (!existing) return upsertSlot(current, slotFromFlatCredentialNamed(flat, nextLoginSlotName(current)));
  // The same human logging in again — an expired token, a second browser round. Refresh the slot
  // in place: appending here minted a phantom account that the picker then offered as a `[sub]` row.
  const refreshed = slotFromFlatCredentialNamed(flat, existing.name);
  const rebased = slotMirrorsFlat(current, existing) ? projectFlatFields(current, refreshed) : current;
  return upsertSlot(rebased, { ...existing, ...refreshed });
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
