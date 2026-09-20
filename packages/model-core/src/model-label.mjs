/**
 * The one short model label for every Rubato surface: statusline footer, model picker,
 * Task widget rows. `openai-codex/gpt-6-astra` reads as `Astra 6`, `xai/grok-4.6` as `Grok 4.6`.
 *
 * Lane decoration (`[fast]`, `[priority]`, `[sub]`, effort) belongs to the caller — this
 * module only names the model.
 */

const FAMILIES = Object.freeze([
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["mythos", "Mythos"],
  ["grok", "Grok"],
  ["gemini", "Gemini"],
  ["kimi", "Kimi"],
  ["composer", "Composer"],
  ["muse-spark", "Muse Spark"],
  ["muse spark", "Muse Spark"],
  ["gpt", "GPT"],
]);

const VARIANTS = Object.freeze([
  ["sol", "Sol"],
  ["luna", "Luna"],
  ["terra", "Terra"],
  ["astra", "Astra"],
]);

// Ids whose version the generic parser cannot read (`k3` is not a number tail).
const EXACT_LABELS = Object.freeze({
  "gpt-daybreak-blue-latest": "Daybreak Blue",
  "gpt-daybreak-blue-latest-fast": "Daybreak Blue",
  "kimi-k3": "Kimi K3",
  "deepseek-v4.1-flash": "v4.1 Flash",
});

function parseVersion(tail) {
  const parts = [];
  let part = "";
  for (const ch of tail) {
    if (ch >= "0" && ch <= "9") {
      part += ch;
    } else if ((ch === "-" || ch === ".") && part) {
      parts.push(part);
      part = "";
    } else {
      break;
    }
  }
  if (part) parts.push(part);
  while (parts.length > 0 && parts[parts.length - 1].length >= 6) parts.pop();
  if (parts.length === 0) return "";
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return parts[0];
}

// A catalog may report the same model as `gpt-5.6-sol` (id spelling) or `GPT-5.6 Sol` (friendly
// display name), so every non-alphanumeric run counts as a separator here. Anchoring on hyphen/dot
// alone made the label depend on which spelling the catalog happened to carry, which let the
// statusline and the Task widget disagree about the same resolved model.
function isVariantSeparator(ch) {
  return ch === undefined || !/[a-z0-9]/.test(ch);
}

function variantLabel(lc) {
  for (const [key, label] of VARIANTS) {
    const idx = lc.lastIndexOf(key);
    if (idx < 0) continue;
    // Both edges must be separators: without the trailing check `solar` would render as `Sol`.
    if (!isVariantSeparator(lc[idx - 1]) || !isVariantSeparator(lc[idx + key.length])) continue;
    const before = lc.slice(0, idx).replace(/[^a-z0-9]$/, "").replace(/^gpt[^a-z0-9]/, "");
    const version = parseVersion(before.replace(/^[a-z]+[^a-z0-9]/, "")) || parseVersion(before);
    return version ? `${label} ${version}` : label;
  }
  return "";
}

export function shortModelLabel(modelId) {
  if (!modelId) return "unknown";
  const bare = String(modelId).split("/").pop();
  const modelName = bare.split(":", 1)[0];
  const lc = modelName.toLowerCase();
  const exact = EXACT_LABELS[lc];
  if (exact) return exact;
  const variant = variantLabel(lc);
  if (variant) return variant;
  for (const [key, label] of FAMILIES) {
    const idx = lc.indexOf(key);
    if (idx < 0) continue;
    const tail = lc.slice(idx + key.length).replace(/^[-.\s]+/, "");
    const version = parseVersion(tail);
    return version ? `${label} ${version}` : label;
  }
  const colon = bare.indexOf(":");
  return colon >= 0 ? bare.slice(0, colon) : bare;
}
