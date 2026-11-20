// Rubato kept its interface language as the client setting `uiLanguage` ("en" | "ko").
// T3 now has its own, `language`, which defaults to English. A settings file
// that still carries only Rubato's key opens in that language; the next save
// writes `language` and drops the old key, since the schema does not keep it.
export function withRubatoUiLanguage(settings: unknown): unknown {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return settings;
  if (Object.hasOwn(settings, "language")) return settings;
  const legacy: unknown = (settings as { readonly uiLanguage?: unknown }).uiLanguage;
  return legacy === "ko" ? { ...settings, language: "ko" } : settings;
}
