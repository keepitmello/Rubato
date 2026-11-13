// Rubato: one rubato-pi provider instance carries models from many vendors, and T3's
// ProviderIcon picks one glyph per driver, falling back to OpenAI for a driver it does
// not know. This names the glyph for a Rubato model instead: a vendor T3 already draws
// is sent through as that driver, the rest are Rubato's own marks (RubatoVendorMark.tsx).
// Same choice as the desktop picker (overlay/apps/web/src/components/chat/rubatoModelIcons.tsx).

export type RubatoMark = "deepseek" | "gemini" | "kiro" | "opengateway" | "rubato" | "zhipu";
export type RubatoGlyph =
  | { readonly kind: "driver"; readonly driver: string }
  | { readonly kind: "mark"; readonly mark: RubatoMark };

const RUBATO_DRIVER = "rubato-pi";

// The model slug's first segment is the route (openai-codex/gpt-6.1-sol).
const DRIVER_BY_VENDOR: Readonly<Record<string, string>> = {
  "openai-codex": "codex",
  anthropic: "claudeAgent",
  xai: "grok",
  "google-antigravity": "antigravity",
  cursor: "cursor",
  opencode: "opencode",
};
const MARK_BY_VENDOR: Readonly<Record<string, RubatoMark>> = {
  kiro: "kiro",
  "b-ai": "deepseek",
  opengateway: "opengateway",
  nanogpt: "zhipu",
  "google-vertex": "gemini",
};

/** The glyph for a Rubato model, or null when T3's own choice stands (any other driver). */
export function resolveRubatoGlyph(
  driver: string | null | undefined,
  model: string | null | undefined,
): RubatoGlyph | null {
  if (driver !== RUBATO_DRIVER) return null;
  const slug = (model ?? "").trim().toLowerCase();
  // A gateway is only the road: a DeepSeek or Gemini model keeps its maker's mark.
  if (slug.includes("deepseek")) return { kind: "mark", mark: "deepseek" };
  if (slug.includes("gemini")) return { kind: "mark", mark: "gemini" };
  const vendor = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";
  const vendorDriver = DRIVER_BY_VENDOR[vendor];
  if (vendorDriver) return { kind: "driver", driver: vendorDriver };
  return { kind: "mark", mark: MARK_BY_VENDOR[vendor] ?? "rubato" };
}
