export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-opus-5";
export const CACHE_RETENTION = "long";

export const MODEL_CATEGORIES = Object.freeze({
  grok: "cursor/cursor-grok-4.6",
  opus: "anthropic/claude-opus-5",
  sonnet: "anthropic/claude-sonnet-5",
  fable: "anthropic/claude-fable-5-1",
  haiku: "anthropic/claude-haiku-4-5",
  sol: "openai-codex/gpt-5.6-sol",
  terra: "openai-codex/gpt-5.6-terra",
  luna: "openai-codex/gpt-5.6-luna",
});

// Semantic categories own provider preference and runtime fallback. The task planner resolves
// these ordered chains against the live registry, then carries the remaining available rungs into
// the child runtime. Callers choose the cognitive profile; they do not probe provider ids.
export const MODEL_CATEGORY_CHAINS = Object.freeze({
  grok: Object.freeze([MODEL_CATEGORIES.grok]),
  opus: Object.freeze(["kiro/claude-opus-5", MODEL_CATEGORIES.opus]),
  sonnet: Object.freeze([MODEL_CATEGORIES.sonnet]),
  fable: Object.freeze([MODEL_CATEGORIES.fable]),
  haiku: Object.freeze([MODEL_CATEGORIES.haiku]),
  sol: Object.freeze(["kiro/gpt-5.6-sol", MODEL_CATEGORIES.sol]),
  terra: Object.freeze([MODEL_CATEGORIES.terra]),
  luna: Object.freeze([MODEL_CATEGORIES.luna]),
});

// Senpi ships these agents; rubato-pi does not route to them. They came from
// rubato-native, their rubato.jsonc model routing never reaches this harness, and an
// unrouted agent still shows up in the tool surface as if it were ours. Decide
// them one at a time before turning any back on.
// Memory reflection/dream/facts load a separate config. That overlay must not
// inherit the grok category's Cursor default — those jobs were dying with
// model_not_visible:cursor/cursor-grok-4.6. Task/Agent grok stays Cursor.
export const MEMORY_JOB_MODELS = Object.freeze([
  "xai/grok-4.6",
  "cursor/cursor-grok-4.6-high-fast",
]);

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
