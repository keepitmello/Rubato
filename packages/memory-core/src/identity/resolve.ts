// Memory identity resolution. A store exists only under a name the project chose in
// `memory.agent`; an unset or "auto" value means this folder keeps no memory. Pure; no
// filesystem access.
//
// A slug-safe name is the directory name verbatim; anything else becomes
// "<safe-slug>-<sha256-8>" of the trimmed value, so hostile inputs can never escape the
// layout root and two inputs that sanitize to the same slug still map to distinct directories.

import { createHash } from "node:crypto"
import { buildIdentityPaths, resolveMemoryRoot, type MemoryIdentityPaths } from "./layout"

export const AUTO_AGENT_VALUE = "auto"
export const FALLBACK_SLUG = "agent"
export const MAX_SLUG_LENGTH = 40
export const SHORT_HASH_LENGTH = 8

export interface MemoryIdentity {
  id: string
  safeSlug: string
  paths: MemoryIdentityPaths
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, SHORT_HASH_LENGTH)
}

export function sanitizeToSlug(input: string): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  const dashed = folded.replace(/[^a-z0-9]+/g, "-")
  const collapsed = dashed.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
  const capped = collapsed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "")
  return capped === "" ? FALLBACK_SLUG : capped
}

export function isAutoAgentValue(configAgentValue: string | null | undefined): boolean {
  if (configAgentValue === null || configAgentValue === undefined) return true
  const trimmed = configAgentValue.trim()
  return trimmed === "" || trimmed === AUTO_AGENT_VALUE
}

function deriveExplicitId(trimmedValue: string): { id: string; safeSlug: string } {
  const safeSlug = sanitizeToSlug(trimmedValue)
  // An explicit agent name is operator-chosen, so it becomes the directory name verbatim
  // when it is already slug-safe: the id is what search results print, and a hash suffix
  // is noise a reader (human or model) cannot act on. Path safety does not depend on the
  // suffix -- sanitizeToSlug strips every character outside [a-z0-9-], so traversal is
  // impossible either way. A collision between two chosen names is operator error and is
  // surfaced rather than silently split into separate stores.
  if (trimmedValue === safeSlug) return { id: safeSlug, safeSlug }
  return { id: `${safeSlug}-${shortHash(trimmedValue)}`, safeSlug }
}

/**
 * The store a folder writes to, or undefined when its config leaves `memory.agent` unset or
 * "auto": unnamed folders keep no memory. `cwd` only anchors a relative RUBATO_MEMORY_HOME.
 */
export function resolveMemoryIdentity(
  configAgentValue: string | null | undefined,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): MemoryIdentity | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new TypeError("resolveMemoryIdentity: cwd must be a non-empty path string")
  }
  if (isAutoAgentValue(configAgentValue)) return undefined
  const derived = deriveExplicitId((configAgentValue ?? "").trim())
  const memoryRoot = resolveMemoryRoot(env, cwd)
  return { ...derived, paths: buildIdentityPaths(memoryRoot, derived.id) }
}
