// The system prompt is a property of the session, not of the run that happened to
// start with a user prompt.
//
// Stock 0.86.1 lets `before_agent_start` handlers return `systemPrompt`, which becomes
// the run's `forceSystemPrompt`. That event fires only from `prompt()`. A run started by
// `sendCustomMessage(..., { triggerTurn: true })` — a background-terminal notification,
// a child completion wake — goes straight to `_runAgentPrompt` and never sees it, so the
// request went out with no role prompt at all (cache audit 2026-09-23: system dropped to
// the Claude Code identity blocks, cacheRead fell to the tool prefix, and Fable/Opus 5.5
// dropped every earlier thinking block as `prefix_binding_mismatch`).
//
// Here the prompt is composed from the `system_prompt` extension event on every provider
// request, from the session's current prompt options, whatever started the run. The
// composition is a pure function of session state, so every request sees the same text
// until that state changes.
//
// `before_run` is the same idea for the tool loadout: it fires at the start of every run,
// before the first request declares its tools. Readiness waits (MCP attach) and
// model-gated tool syncs belong there, not on `before_agent_start`. A session reopened
// by a wake used to send its first request without the MCP tools and with look_at /
// read_video gated on the wrong model, then flip back one request later — two full
// misses on every lane without native tool additions (2026-09-21..23: 30 resets).

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.86.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[session-prompt:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[session-prompt:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: PACKAGE_NAME, version: VERSION, path, preimageSha256, apply });
}

export function patchRunner(source) {
  return replaceOnce(
    source,
    `    async emitResourcesDiscover(cwd, reason) {`,
    `    /**
     * Compose the session system prompt. Handlers chain like \`before_agent_start\`:
     * each sees the text so far and may return \`{ systemPrompt }\` to replace it.
     * Returns undefined when no handler changed the rendered prompt.
     */
    async emitSystemPrompt(systemPromptOptions) {
        const options = normalizeBuildSystemPromptOptions(systemPromptOptions);
        // basePrompt is the engine rendering before any handler. A handler that rebuilds the
        // prompt from scratch (the Rubato role prompt) uses it to keep what earlier handlers added.
        const basePrompt = buildSystemPrompt(options);
        let current = basePrompt;
        let changed = false;
        const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(this.createContext()));
        ctx.getSystemPrompt = () => {
            this.assertActive();
            return current;
        };
        for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "system_prompt")) {
            for (const handler of handlers) {
                try {
                    const event = { type: "system_prompt", systemPrompt: current, basePrompt, systemPromptOptions: options };
                    const result = await handler(event, ctx);
                    if (result && typeof result.systemPrompt === "string") {
                        current = result.systemPrompt;
                        changed = true;
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: "system_prompt",
                        error: message,
                        stack,
                    });
                }
            }
        }
        return changed ? current : undefined;
    }
    async emitResourcesDiscover(cwd, reason) {`,
    "runner-emit-system-prompt",
  );
}

export function patchAgentSession(source) {
  let next = replaceOnce(
    source,
    `            const forced = this._runSystemPromptOptions?.forceSystemPrompt;
            if (forced === undefined)
                return transformed;`,
    `            const forced = this._runSystemPromptOptions?.forceSystemPrompt ?? await this._composeSessionSystemPrompt();
            if (forced === undefined)
                return transformed;`,
    "projection-compose",
  );
  next = replaceOnce(
    next,
    `    /** Restore the active tool loadout declared by the session transcript, if it declares one. */`,
    `    /**
     * The session's composed prompt for the next request. Every run shape reaches this
     * through the projection, so a wake-started run carries the same prompt as a prompted one.
     */
    async _composeSessionSystemPrompt() {
        const runner = this._extensionRunner;
        if (!runner?.hasHandlers?.("system_prompt"))
            return undefined;
        const base = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
        const composed = await runner.emitSystemPrompt({ ...base, selectedTools: this.getActiveToolNames() });
        this._composedSystemPrompt = composed;
        return composed;
    }
    /** Restore the active tool loadout declared by the session transcript, if it declares one. */`,
    "compose-method",
  );
  next = replaceOnce(
    next,
    `    async _runAgentPrompt(messages) {
        this._agentRunAbortRequested = false;
        this._isAgentRunActive = true;
        try {
            await this.agent.prompt(messages);`,
    `    async _runAgentPrompt(messages) {
        this._agentRunAbortRequested = false;
        this._isAgentRunActive = true;
        try {
            // Every run shape passes here before its tool loadout is declared, including a
            // wake started by sendCustomMessage(triggerTurn), which skips before_agent_start.
            await this._extensionRunner?.emit({ type: "before_run" });
            await this.agent.prompt(messages);`,
    "before-run",
  );
  return replaceOnce(
    next,
    `    get systemPrompt() {
        return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);`,
    `    get systemPrompt() {
        const forced = this._runSystemPromptOptions?.forceSystemPrompt ?? this._composedSystemPrompt;
        if (forced !== undefined)
            return forced;
        return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);`,
    "system-prompt-getter",
  );
}

export const patches = Object.freeze([
  patch("session-prompt:core/extensions/runner.js", "dist/core/extensions/runner.js", "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2", patchRunner),
  patch("session-prompt:core/agent-session.js", "dist/core/agent-session.js", "edaff7055ced7d49d25135c92415fbbfd9c14c4a29be5a79510ab9216045d6d9", patchAgentSession),
]);

export const files = Object.freeze([]);
export const sessionPromptFeature = Object.freeze({ id: "session-prompt", patches, files });
export const feature = sessionPromptFeature;
export default sessionPromptFeature;
