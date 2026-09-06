// rubato patched copy of senpi-codemode/src/prompt/eval-prompt.ts.
// Diff from vendor: one short common rule (direct tools vs eval), no per-model
// batching dialects in the rendered prompt. Wired by control-codemode-redirect.mjs.
import type { EvalRuntimeInfo } from "../tool/types.ts";

export interface EnabledLanguages {
	readonly py: boolean;
	readonly js: boolean;
	readonly rb: boolean;
	readonly jl: boolean;
}

export interface EvalPromptParts {
	readonly description: string;
	readonly promptSnippet: string;
	readonly promptGuidelines: readonly string[];
}

export interface EvalPromptOptions {
	readonly spawns: boolean;
	/** Whether the session registry exposes the monitor tool through eval. */
	readonly monitor?: boolean;
	readonly spawnDefaultAgent?: string;
	/** Active model id; style helpers still classify it, rendered guidance does not branch. */
	readonly modelId?: string;
	/** Preformatted host line (e.g. "darwin arm64 · Apple M5 Max · 18 cores"); enables the host identity line. */
	readonly hostLine?: string;
	/** Identity of the in-process js kernel; a bun runtime swaps the Node.js worker line for the Bun one. */
	readonly jsRuntime?: EvalRuntimeInfo;
	/** Absolute path of the active bun-1-4 skill; rendered as a MUST READ pointer only on a bun kernel. */
	readonly bunSkillPath?: string;
}

/** Prompt dialect for eval composition emphasis. */
export type EvalEmphasisStyle = "default" | "claude" | "codex" | "gpt" | "kimi";

const CLAUDE_MODEL_RE = /(^|[/.:])claude[-.]/i;
const GLM_MODEL_RE = /(^|[/.:@-])glm[-.]?\d/i;
const KIMI_MODEL_RE = /(^|[/.:])kimi[-.]/i;
const OPENAI_MODEL_RE = /(^|[/.:])(gpt|chatgpt|codex)[-.]|(^|[/.:])o[134](?:[-.]|$)/i;

/**
 * Selects the eval composition dialect for a model id:
 * - `claude`: Claude/GLM — direct imperatives; both are steered most reliably
 *   by explicit tagged directives (GLM prompting guidance routes to Claude's).
 * - `gpt`: GPT models — terse composition-forward rules that direct detached
 *   cells to notify on completion instead of being polled.
 * - `codex`: Other OpenAI reasoning families — terse bounded rules, no emphasis spam.
 * - `kimi`: Kimi K-series — positive imperatives (uppercase/bold DO-framing);
 *   all-caps NEVER prohibitions stay out because they make K-series overthink.
 * - `default`: everything else (and no model) — same optional-eval rules.
 */
/** True only for GPT model ids that receive the terse eval composition dialect. */
export function isGptCodeModeModel(modelId: string | undefined): boolean {
	return modelId !== undefined && /(^|[/.:])gpt[-.]/iu.test(modelId);
}

export function evalEmphasisStyle(modelId: string | undefined): EvalEmphasisStyle {
	if (!modelId) return "default";
	if (isGptCodeModeModel(modelId)) return "gpt";
	if (CLAUDE_MODEL_RE.test(modelId) || GLM_MODEL_RE.test(modelId)) return "claude";
	if (KIMI_MODEL_RE.test(modelId)) return "kimi";
	if (OPENAI_MODEL_RE.test(modelId)) return "codex";
	return "default";
}

type ContextValue = string | boolean;
type Context = Readonly<Record<string, ContextValue>>;
const EVAL_PROMPT_TEMPLATE = `Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** Top-level names persist per language across eval calls{{#if spawns}}, tool calls and \`task\` subagents{{else}} and tool calls{{/if}}. Reuse helpers; rebuild only after \`reset\`, a kernel restart, or a \`NameError\`/\`ReferenceError\`. Check a sentinel before re-running to avoid duplicate side effects.

Ordinary calls are direct tools. Use eval for programmatic intermediates or persistent calculations; \`parallel(thunks)\` is available inside a cell.
{{#if hostLine}}
Host: {{hostLine}} — cells execute here; \`tool.<name>()\` shell commands must fit this platform, even when the code you are writing targets another machine.
{{/if}}

\`language\`: {{#if py}}\`"py"\` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}\`"js"\` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}\`"rb"\` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}\`"jl"\` persistent Julia kernel{{/if}}.

A cell that outlives the foreground window detaches (kernel stays busy; other languages can continue) and completes as one notification. Do not re-run a detached cell; peek or stop with \`eval({ action: "peek", cell_id })\` / \`eval({ action: "stop", cell_id })\`.

{{#if py}}Python runs on a live event loop: use top-level \`await\`; \`asyncio.run(…)\` raises.{{/if}}
{{#if js}}{{#if jsBun}}JS runs in-process on Bun {{jsVersion}}: top-level \`await\`/\`return\`; \`Bun.*\` including \`new Bun.WebView()\` before curl or a browser CLI.{{#if bunSkillPath}} MUST READ the bun-1-4 skill at {{bunSkillPath}} before your first js cell.{{/if}}{{else}}JS runs under Node.js worker: top-level \`await\`/\`return\`; \`fetch\`/\`Buffer\` available.{{/if}}{{/if}}
{{#if rb}}Ruby: sync, keyword args{{#if spawns}} (e.g. \`output("id", limit: 2)\`){{/if}}; last expression auto-displays unless \`nil\`, assignment, or definition.{{/if}}
{{#if jl}}Julia: sync, keyword args{{#if spawns}} (e.g. \`output("id", limit=2)\`){{/if}}; last expression auto-displays unless assignment or definition.{{/if}}
On error, fix and re-run only the failing step; a normal error keeps state; timeout/stop says if the kernel restarted.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order. Python: sync, trailing kwargs. JS: async, ONE trailing object literal (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/\`await\`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, trailing keyword args.{{/if}}{{#if jl}} Julia: sync, trailing keyword args.{{/if}}
\`\`\`
display(value) → None
print(value, ...) → None
read(path, offset?=1, limit?=None) → str
    1-indexed lines; accepts \`local://…\`.
write(path, content) → str
    Creates parents; returns path. \`local://…\` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args: all; one: get; two: set.
{{#if spawns}}output(*ids, format?="raw", offset?=None, limit?=None) → str | dict | list[dict]
{{/if}}tool.<name>(args) → unknown
tool_schema(name?) → dict
    Omit name to list tools; failed tool calls also return their schema.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Stateless; model: smol/default/slow. JSON-Schema gives a parsed result.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
{{/if}}parallel(thunks) → list
pipeline(items, ...stages) → list
log(message) → None
phase(title) → None
\`\`\`
</prelude>
{{#if spawns}}
<workflow>
One \`agent(…)\` node per step with handle ({{#if py}}\`handle=True\`{{/if}}{{#ifAll py js}} / {{/ifAll}}{{#if js}}\`{ handle: true }\`{{/if}}{{#if jl}}{{#ifAny py js}} / {{/ifAny}}\`handle=true\`{{/if}}); \`parallel(thunks)\` for independent nodes; \`pipeline(items, *stages)\` for waves. Pass \`handle\`/\`output\` or \`write("local://…")\` into dependents; try/except a risky subtree.
</workflow>
{{/if}}
`;

export function buildEvalPrompt(
	enabled: EnabledLanguages,
	options: EvalPromptOptions = { spawns: false },
): EvalPromptParts {
	if (!enabled.py && !enabled.js && !enabled.rb && !enabled.jl) {
		throw new Error("no kernels enabled for eval prompt");
	}
	const spawnDefaultAgent = options.spawnDefaultAgent ?? "task";
	const style = evalEmphasisStyle(options.modelId);
	const context: Context = {
		py: enabled.py,
		js: enabled.js,
		rb: enabled.rb,
		jl: enabled.jl,
		spawns: options.spawns,
		spawnDefaultAgent,
		hostLine: options.hostLine ?? "",
		jsBun: options.jsRuntime?.name === "bun",
		jsVersion: options.jsRuntime?.version ?? "",
		bunSkillPath: options.bunSkillPath ?? "",
	};
	const description = renderTemplate(EVAL_PROMPT_TEMPLATE, context)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		description,
		promptSnippet: "Run one incremental code cell in a persistent language kernel.",
		promptGuidelines: [
			BATCHING_GUIDELINES[style],
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		],
	};
}

const COMMON_GUIDELINE =
	"Ordinary calls are direct tools. Use eval for programmatic intermediates or persistent calculations; parallel(thunks) is available inside a cell.";

/** Same guideline for every dialect so callers of evalEmphasisStyle stay compatible. */
const BATCHING_GUIDELINES: Record<EvalEmphasisStyle, string> = {
	default: COMMON_GUIDELINE,
	claude: COMMON_GUIDELINE,
	codex: COMMON_GUIDELINE,
	gpt: COMMON_GUIDELINE,
	kimi: COMMON_GUIDELINE,
};

function renderTemplate(template: string, context: Context): string {
	let index = 0;
	const [rendered, nextIndex] = renderUntil(template, context, index, []);
	index = nextIndex;
	if (index !== template.length) {
		throw new Error("unexpected template close tag");
	}
	return rendered;
}

function renderUntil(
	template: string,
	context: Context,
	start: number,
	stopTags: readonly string[],
): readonly [string, number, string?] {
	let rendered = "";
	let index = start;
	while (index < template.length) {
		const open = template.indexOf("{{", index);
		if (open < 0) {
			return [rendered + template.slice(index), template.length];
		}
		rendered += template.slice(index, open);
		const close = template.indexOf("}}", open + 2);
		if (close < 0) {
			throw new Error("unterminated template tag");
		}
		const tag = template.slice(open + 2, close).trim();
		index = close + 2;
		if (stopTags.includes(tag)) {
			return [rendered, index, tag];
		}
		if (tag.startsWith("#")) {
			const [block, nextIndex] = renderBlock(template, context, index, tag);
			rendered += block;
			index = nextIndex;
			continue;
		}
		if (tag.startsWith("/")) {
			throw new Error(`unexpected template close tag ${tag}`);
		}
		rendered += valueFor(tag, context);
	}
	return [rendered, index];
}

function renderBlock(template: string, context: Context, start: number, openTag: string): readonly [string, number] {
	const [kind, ...names] = openTag.slice(1).split(/\s+/);
	const closeTag = `/${kind}`;
	const [truthyText, afterTruthy, stopTag] = renderUntil(template, context, start, ["else", closeTag]);
	let falseyText = "";
	let end = afterTruthy;
	if (stopTag === "else") {
		const [elseText, afterElse, elseStop] = renderUntil(template, context, afterTruthy, [closeTag]);
		if (elseStop !== closeTag) {
			throw new Error(`missing close tag for ${kind}`);
		}
		falseyText = elseText;
		end = afterElse;
	} else if (stopTag !== closeTag) {
		throw new Error(`missing close tag for ${kind}`);
	}
	return [condition(kind, names, context) ? truthyText : falseyText, end];
}

function condition(kind: string, names: readonly string[], context: Context): boolean {
	if (kind === "if") {
		return names.length === 1 && Boolean(context[names[0]]);
	}
	if (kind === "ifAll") {
		return names.length > 0 && names.every((name) => Boolean(context[name]));
	}
	if (kind === "ifAny") {
		return names.length > 0 && names.some((name) => Boolean(context[name]));
	}
	throw new Error(`unknown template condition ${kind}`);
}

function valueFor(name: string, context: Context): string {
	const value = context[name];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "boolean" || value === undefined) {
		return "";
	}
	return String(value);
}
