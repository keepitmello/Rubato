import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchTuiAutocomplete, patchTuiEditor, patches } from "./patches.mjs";
import { patchModelSelector } from "../model-picker/patches.mjs";
import { supportedThinkingLevels } from "../thinking-levels/thinking-levels.mjs";
import { installTitleGuard } from "../title-guard/title-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.RUBATO_A2A3_EVIDENCE_DIR || join(here, "evidence");
mkdirSync(outDir, { recursive: true });
const tuiDist = join(here, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist");
const agentDist = join(here, "../../node_modules/@earendil-works/pi-coding-agent/dist");

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x07/g, "");
}

function writeCapture(name, lines) {
  const body = Array.isArray(lines) ? lines.map(stripAnsi).join("\n") : String(lines);
  const path = join(outDir, name);
  writeFileSync(path, body.endsWith("\n") ? body : body + "\n");
  return path;
}

const work = join(outDir, "work");
mkdirSync(join(work, "rubato-features/tui-autocomplete"), { recursive: true });
mkdirSync(join(work, "components"), { recursive: true });
const acPatched = patchTuiAutocomplete(readFileSync(join(tuiDist, "autocomplete.js"), "utf8"));
writeFileSync(join(work, "autocomplete.js"), acPatched);
writeFileSync(join(work, "fuzzy.js"), readFileSync(join(tuiDist, "fuzzy.js")));
cpSync(join(here, "inline.mjs"), join(work, "rubato-features/tui-autocomplete/inline.mjs"));

const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(work, "autocomplete.js")).href);
const provider = new CombinedAutocompleteProvider([
  { name: "resume", description: "resume a session" },
  { name: "skill:web-search", description: "search the web" },
  { name: "skill:weather", description: "weather" },
], process.cwd());

const midLine = ["first line of a prompt", "please /skill:we"];
const suggestions = await provider.getSuggestions(midLine, 1, midLine[1].length, { force: false });
const popup = [
  midLine[0],
  midLine[1] + "|",
  "┌ autocomplete (line 1) ─────────────┐",
  ...(suggestions?.items ?? []).map((item, index) => `│ ${index === 0 ? "→" : " "} ${item.label || item.value}`.padEnd(39) + "│"),
  "└─────────────────────────────────────┘",
  `prefix=${suggestions?.prefix ?? "null"}`,
];
const autocompleteCapture = writeCapture("autocomplete-second-line.txt", popup);

const editorPatched = patchTuiEditor(readFileSync(join(tuiDist, "components/editor.js"), "utf8"));
writeCapture("editor-isSlashMenuAllowed.txt", [
  editorPatched.includes("isSlashMenuAllowed() {\n        return true;") ? "isSlashMenuAllowed: true (all lines)" : "FAIL",
  editorPatched.includes("isInlineSlash") ? "isInlineSlash: present" : "FAIL",
  editorPatched.includes("isInlineDollar") ? "isInlineDollar: present" : "FAIL",
]);

const selectorPatched = patchModelSelector(readFileSync(join(agentDist, "modes/interactive/components/model-selector.js"), "utf8"));
writeFileSync(join(work, "model-selector.patched.js"), selectorPatched);
const { sortModelItems, modelPickerLabel } = await import(pathToFileURL(join(here, "../model-picker/catalog.mjs")).href);
const models = [
  { provider: "cursor", id: "composer-2.5", model: { name: "Composer" } },
  { provider: "xai", id: "grok-4.6", model: { name: "Grok" } },
  { provider: "cursor", id: "gpt-5.6-sol", model: { name: "Sol" } },
  { provider: "openai-codex", id: "gpt-5.6-luna", model: { name: "Luna" } },
  { provider: "openai-codex", id: "gpt-5.6-sol", model: { name: "Sol" } },
  { provider: "anthropic", id: "claude-opus-5", model: { name: "Opus" } },
  { provider: "anthropic", id: "claude-fable-5-1", model: { name: "Fable" } },
  { provider: "cursor", id: "cursor-grok-4.6", model: { name: "Grok Fast" } },
];
const sorted = sortModelItems(models);
const pickerLines = ["Model selector (provider groups, Sol first)", "────────────────────────────────────────"];
let lastProvider = null;
for (const item of sorted) {
  if (item.provider !== lastProvider) {
    pickerLines.push(`[${item.provider}]`);
    lastProvider = item.provider;
  }
  pickerLines.push(`  ${modelPickerLabel(item)} [${item.provider}]`);
}
const pickerCapture = writeCapture("model-picker-list.txt", pickerLines);

const beforeLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const afterLevels = supportedThinkingLevels({
  id: "gpt-5.6-sol",
  reasoning: true,
  thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
});
const cycleCapture = writeCapture("thinking-cycle.txt", [
  `stock Shift+Tab cycle: ${beforeLevels.join(" → ")}`,
  `rubato Shift+Tab cycle: ${afterLevels.join(" → ")}`,
  `skipped: ${beforeLevels.filter((level) => !afterLevels.includes(level)).join(", ")}`,
]);

const writes = [];
class FakeTerminal {
  setTitle(title) {
    const sanitized = String(title).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    writes.push(`\x1b]0;${sanitized}\x07`);
  }
}
const unguarded = new FakeTerminal();
for (let i = 0; i < 40; i += 1) unguarded.setTitle("rubato - bash");
const beforeCount = writes.length;
writes.length = 0;
installTitleGuard(FakeTerminal.prototype);
const guarded = new FakeTerminal();
for (let i = 0; i < 40; i += 1) guarded.setTitle("rubato - bash");
const afterCount = writes.length;
const titleCapture = writeCapture("title-guard-osc.txt", [
  `OSC 0 before guard (40 identical setTitle): ${beforeCount}`,
  `OSC 0 after guard (40 identical setTitle): ${afterCount}`,
  `bytes: ${JSON.stringify(writes)}`,
]);

const hashes = Object.fromEntries(patches.map((entry) => [entry.id, entry.preimageSha256]));
writeFileSync(join(outDir, "hashes.json"), JSON.stringify({ hashes, shaProbe: createHash("sha256").update("ok").digest("hex") }, null, 2));

console.log(JSON.stringify({
  autocompleteCapture,
  pickerCapture,
  cycleCapture,
  titleCapture,
  titleOscBefore: beforeCount,
  titleOscAfter: afterCount,
  suggestions: suggestions?.items?.map((item) => item.value),
  pickerOrder: sorted.map((item) => `${item.provider}/${modelPickerLabel(item)}`),
  thinkingAfter: afterLevels,
}, null, 2));
