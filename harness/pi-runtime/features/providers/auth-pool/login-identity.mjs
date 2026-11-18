import { dirname, join } from "node:path";
import { listSlots, loginAccountIdentity } from "./slots.mjs";
import { CREDENTIAL_POOL_STATE_FILENAME, CredentialSlotRepository } from "./state-store.mjs";

// Anthropic tokens are opaque, so a re-login of the same human was always "unknown" and landed in
// a new `login-N` slot that no picker row reaches, while the `[sub]` row stayed on the old, blocked
// slot (2026-11-18: codesmith re-logged into `login-3`, `sub` kept its auth_error block).
// The API names the organization on every response; a personal plan's organization is one human.
const ANTHROPIC_API = "https://api.anthropic.com";
const PERSONAL_PLANS = new Set(["claude_max", "claude_pro"]);
const PROBE_TIMEOUT_MS = 5_000;

function anthropicHeaders(token) {
  const headers = { "anthropic-version": "2023-06-01" };
  if (token.startsWith("sk-ant-oat")) {
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

async function anthropicGet(fetchImpl, path, token) {
  try {
    const response = await fetchImpl(`${ANTHROPIC_API}${path}`, {
      headers: anthropicHeaders(token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

function secretOf(source) {
  if (typeof source?.key === "string" && source.key !== "") return source.key;
  if (typeof source?.access === "string" && source.access !== "") return source.access;
  return undefined;
}

function liveSecretOf(slot, now) {
  if (typeof slot.key === "string" && slot.key !== "") return slot.key;
  return typeof slot.expires === "number" && slot.expires > now ? secretOf(slot) : undefined;
}

async function anthropicIdentities(current, incoming, fetchImpl) {
  if (typeof incoming?.access !== "string" || incoming.access === "") return undefined;
  const profile = await (await anthropicGet(fetchImpl, "/api/oauth/profile", incoming.access))?.json().catch(() => undefined);
  const organization = profile?.organization;
  if (!PERSONAL_PLANS.has(organization?.organization_type) || typeof organization.uuid !== "string") return undefined;
  const known = new Map([[incoming.access, organization.uuid]]);
  const now = Date.now();
  await Promise.all(listSlots(current).map(async (slot) => {
    const secret = liveSecretOf(slot, now);
    if (secret === undefined) return;
    const org = (await anthropicGet(fetchImpl, "/v1/models", secret))?.headers.get("anthropic-organization-id");
    if (org) known.set(secret, org);
  }));
  return known;
}

/**
 * Who each credential belongs to, for appendLoginSlot. Credentials that name themselves (JWTs,
 * API keys) keep loginAccountIdentity; Anthropic logins on a personal plan are matched by the
 * organization the API reports for each stored slot.
 */
export async function loginIdentityResolver(providerId, current, incoming, { fetchImpl = fetch } = {}) {
  const known = providerId === "anthropic" && current
    ? await anthropicIdentities(current, incoming, fetchImpl)
    : undefined;
  if (!known) return loginAccountIdentity;
  return (source) => {
    const org = known.get(secretOf(source));
    return org === undefined ? loginAccountIdentity(source) : `anthropic-org:${org}`;
  };
}

/**
 * A re-login replaced this slot's credential, so the pool record earned by the old one no longer
 * applies. `auth_error` blocks are permanent and setup-token slots cannot be `rubato auth check`ed,
 * so without this the re-logged account stayed blocked.
 */
export async function clearReplacedSlotState(credentials, providerId, slotName) {
  const authPath = credentials?.store?.authPath ?? credentials?.authPath;
  if (typeof slotName !== "string" || typeof authPath !== "string" || authPath === "") return;
  const repository = new CredentialSlotRepository(join(dirname(authPath), CREDENTIAL_POOL_STATE_FILENAME));
  await repository.mutateSlotState(providerId, "stored", slotName, () => undefined);
}
