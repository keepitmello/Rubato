export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-opus-5";
export const CACHE_RETENTION = "long";

export const MODEL_CATEGORIES = Object.freeze({
  grok: "cursor/cursor-grok-4.6",
  opus: "anthropic/claude-opus-5",
  sonnet: "anthropic/claude-sonnet-5",
  fable: "anthropic/claude-fable-5",
  haiku: "anthropic/claude-haiku-4-5",
  sol: "openai-codex/gpt-5.6-sol",
  terra: "openai-codex/gpt-5.6-terra",
  luna: "openai-codex/gpt-5.6-luna",
});

// Senpi ships these agents; rubato-pi does not route to them. They came from
// rubato-native, their rubato.jsonc model routing never reaches this harness, and an
// unrouted agent still shows up in the tool surface as if it were ours. Decide
// them one at a time before turning any back on.
export const DISABLED_AGENT_NAMES = Object.freeze([
  "explore",
  "librarian",
  "metis",
  "momus",
]);

export const DISABLED_CATEGORY_NAMES = Object.freeze([
  "visual-engineering",
  "artistry",
  "ultrabrain",
  "deep",
  "quick",
  "unspecified-low",
  "architect",
  "unspecified-high",
  "writing",
]);
