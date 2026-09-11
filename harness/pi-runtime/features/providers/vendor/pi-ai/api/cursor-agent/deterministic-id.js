import { createHash } from "node:crypto";
/**
 * Format the leading 128 bits of `seed`'s SHA-256 digest as a v4-shape UUID
 * (8-4-4-4-12 hex groups).
 *
 * Deterministic: identical seeds always map to the same id, so callers get
 * stable ids across requests / conversation turns (reusing message-blob ids,
 * keying prompt caches) without persisting a seed→id mapping.
 */
export function deterministicUuid(seed) {
    const hex = createHash("sha256").update(seed).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
//# sourceMappingURL=deterministic-id.js.map