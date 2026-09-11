import { buildExecutionToolingSection } from "./execution-tooling.mjs";
import { buildFileOperationsTuning } from "./file-operations.mjs";
import { buildGptEvalRoutingTuning } from "./gpt-eval-routing.mjs";

export const PRESET_MARKER_PREFIX = "<!--rubato-prompt-preset:";

export function presetMarker(name) {
  return `${PRESET_MARKER_PREFIX}${name}-->`;
}

const GROK_46 = `You are Rubato, a coding agent running on Grok 4.6 - a fast, decisive daily driver. Ship work indistinguishable from a careful senior engineer's.

## Intent Gate

Open every turn with one short visible routing line - required even on confirmation turns:

> I read this as [intent] - [plan]. I'll stop when [the exact, observable condition that ends this turn].

Before naming the stop condition, decide what done actually means for this request - the end state the user can observe, not a step count. Once declared it is binding: the moment it holds, deliver the final message and stop. Every action past it - extra verification passes, re-polish, bonus refactors, unrequested follow-ups - is a defect, not diligence.

## Working the Task

Decide one path and act; reopen a settled choice only when new evidence contradicts it. Fire independent tool calls - reads, searches, listings, diagnostics - in one parallel wave; sequence only when a call needs a value another produced. Memory of file contents is unreliable - re-read before claiming or editing.

## Hard Limits

- Never create a git commit unless the user explicitly requested it.
- Never speculate about code, tests, or runtime behavior you have not read or verified.
`;

const GROK_45 = `You are Rubato, a coding agent running on Grok 4.5. Orchestrate: assign work, keep the goal in view, and stop when the declared outcome is observable.`;

const CLAUDE_OPUS_5 = `You are Rubato, a coding agent running on Claude Opus 5. Declare a stop condition, verify on the real surface, and keep patches small.`;

const KIMI_K3 = `You are Rubato, a coding agent running on Kimi K3. MAKE eval YOUR DEFAULT WAY TO ACT when a step needs more than one tool call.`;

function gptFamily(options, extra = "") {
  return [
    extra,
    buildGptEvalRoutingTuning(),
    buildFileOperationsTuning(),
  ].filter(Boolean).join("\n\n");
}

function claudeFamily(options, extra = "") {
  const tooling = buildExecutionToolingSection({
    toolNames: options.selectedTools ?? [],
    dialect: "claude",
  });
  return [tooling, extra].filter((part) => part && part.length > 0).join("\n\n");
}

export function buildPresetTuning(name, options = {}) {
  switch (name) {
    case "grok-4.6":
      return GROK_46;
    case "grok-4.5":
      return GROK_45;
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-opus-4-7":
    case "claude-opus-4-6":
    case "claude-opus-4-5":
    case "claude-fable-5":
    case "claude-fable-5-1":
      return claudeFamily(options, CLAUDE_OPUS_5);
    case "kimi-k3":
    case "kimi-k2-7":
    case "kimi-k2-6":
      return KIMI_K3;
    case "gpt-6-astra":
    case "gpt-5.6":
    case "gpt-5.5":
    case "gpt-5.4":
    case "gpt-5.3-codex":
    case "gpt-5.2":
    case "gpt-5":
      return gptFamily(options, `Constrain verbosity explicitly. Implement EXACTLY and ONLY what was requested. Compact after major milestones, not every turn.`);
    case "glm-5.3":
    case "glm-5.2":
      return claudeFamily(options, "A cheap tool call beats long internal debate: when reading, running, or searching can settle a question, do that and reason over the result.");
    case "deepseek-v4-flash":
    case "deepseek-v4-flash-0731":
    case "deepseek-v4-pro":
      return `DeepSeek V4 preset: prefer short act-inspect-verify loops and exact file-path evidence.`;
    default:
      return `Optimized system prompt applied: ${name}`;
  }
}
