// Rubato's admitted provider set.
//
// Keep this module pure: it is imported by profile/defaults code and by tests
// that must not load the installed engine (engine-paths can repair live
// node_modules links as an import side effect). Transport factories and auth
// implementations stay in provider-direct.mjs and the provider route modules.

export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "xai",
  "cursor",
  "anthropic",
  "kiro",
  "google-antigravity",
  "opencode",
]);

function providerId(provider, index) {
  const id = provider?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`provider admission: provider at index ${index} has no id`);
  }
  return id;
}

/**
 * Validate the complete provider set before registration or credential import.
 *
 * Ordering is part of the product contract: callers and the picker expect the
 * same seven lanes in this order. Returning a copy prevents a factory from
 * changing the admitted set after the check but before registration.
 */
export function validateProviderAdmission(providers, expectedIds = SUPPORTED_PROVIDER_IDS) {
  if (!Array.isArray(providers)) {
    throw new TypeError("provider admission: factory result must be an array");
  }

  const ids = providers.map(providerId);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`provider admission: duplicate provider id(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  const expected = [...expectedIds];
  const expectedSet = new Set(expected);
  const actualSet = new Set(ids);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = ids.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail = [
      missing.length > 0 ? `missing=${missing.join(",")}` : "",
      unexpected.length > 0 ? `unexpected=${unexpected.join(",")}` : "",
    ].filter(Boolean).join(" ");
    throw new Error(`provider admission: incomplete provider set (${detail})`);
  }

  if (ids.some((id, index) => id !== expected[index])) {
    throw new Error(
      `provider admission: provider order mismatch (expected=${expected.join(",")} actual=${ids.join(",")})`,
    );
  }

  return Object.freeze([...providers]);
}

/** Register only a structurally complete set; malformed sets cause zero writes. */
export function admitProviders(pi, providers, expectedIds = SUPPORTED_PROVIDER_IDS) {
  if (typeof pi?.registerProvider !== "function") {
    throw new TypeError("provider admission: registerProvider is unavailable");
  }
  const admitted = validateProviderAdmission(providers, expectedIds);
  for (const provider of admitted) pi.registerProvider(provider);
  return admitted;
}
