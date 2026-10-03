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
//
// The projection keeps the transcript's tool history in place. Stock collapses every
// system message into the head, so a tool activated mid-session moved into the leading
// tool list and rewrote the prefix ahead of the whole history — even on lanes that load
// later tools natively (Anthropic `tool_addition`, Codex `additional_tools`). The head now
// carries the tools the first system message declared; later system messages keep their
// `toolsAdded`/`toolsRemoved` and drop their text, which the composed prompt already
// renders. Replaying the result yields the same current tools, and a lane that cannot take
// mid-conversation system messages still collapses it in the provider.
//
// A custom message sent with `triggerTurn: false` while a run streams (the loop guard's
// notice, a compaction hook's context) is held until the turn's tool results are in. Up to
// 0.86 the running loop built requests from its own context copy, so this feature handed
// held messages to the loop as prepared messages. Since 0.87 every request is built from
// the SessionManager projection and stock's `turn_end` flush appends to the session, so the
// next request of the same run already carries them right after the latest tool results.
// That part was deleted in the 1.0.1 migration; session-prompt.test.mjs pins the behavior.

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as VERSION } from "../../pi-version.mjs";

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

// 0.87 stopped showing system messages to \`context\` handlers. When a handler changes the
// conversation, stock replaces every system message with one replayed head that carries the
// current prompt and ALL current tools. Rubato's context handlers change messages on most
// requests (large tool output previews, history-notes markers, image limits), so a tool that
// tool_search loaded mid-session moved into the leading tool list and the provider prefix
// changed from token 0 (audit 2026-10-03, checks/collapse.mjs). This puts each system
// message back in front of the conversation message it preceded. A returned message is matched
// to the one it came from by identity, else by a forward search for the same role, timestamp
// and call id (handlers rewrite content through \`{ ...message, content }\` copies, and
// history-notes also inserts reminders, so lengths differ), else by position when the length
// is unchanged. Inserted messages match nothing and stay where the handler put them. A system
// message whose follower was
// dropped goes before the next surviving one, so the replayed tool state is unchanged. Only
// a reordering handler falls back to stock's single head.
export function patchRunnerSystemSlots(source) {
  return replaceOnce(
    source,
    `function restoreSystemMessages(current, visible, returned) {
    if (sameMessages(returned, visible))
        return current;
    const head = getCurrentSystemMessage(current);`,
    `function restoreSystemMessagesInPlace(current, visible, returned) {
    const groups = visible.map(() => []);
    const lead = [];
    const tail = [];
    let next = 0;
    for (const message of current) {
        if (message.role !== "system") {
            next++;
            continue;
        }
        if (next === 0)
            lead.push(message);
        else if (next < visible.length)
            groups[next].push(message);
        else
            tail.push(message);
    }
    const indexOf = new Map(visible.map((message, index) => [message, index]));
    const positional = returned.length === visible.length;
    const keyOf = (message) => \`\${message?.role}\\u0000\${message?.timestamp ?? ""}\\u0000\${message?.toolCallId ?? ""}\\u0000\${message?.customType ?? ""}\`;
    const keys = visible.map(keyOf);
    const out = [...lead];
    let emitted = 0;
    let searchFrom = 0;
    for (let index = 0; index < returned.length; index++) {
        const message = returned[index];
        let anchor = indexOf.get(message);
        if (anchor === undefined) {
            const key = keyOf(message);
            for (let candidate = searchFrom; candidate < keys.length; candidate++) {
                if (keys[candidate] === key) {
                    anchor = candidate;
                    break;
                }
            }
        }
        if (anchor === undefined && positional)
            anchor = index;
        if (anchor !== undefined)
            searchFrom = anchor + 1;
        if (anchor !== undefined) {
            if (anchor < emitted)
                return undefined;
            for (; emitted <= anchor; emitted++)
                out.push(...groups[emitted]);
        }
        out.push(message);
    }
    for (; emitted < groups.length; emitted++)
        out.push(...groups[emitted]);
    out.push(...tail);
    return out;
}
function restoreSystemMessages(current, visible, returned) {
    if (sameMessages(returned, visible))
        return current;
    const inPlace = restoreSystemMessagesInPlace(current, visible, returned);
    if (inPlace)
        return inPlace;
    const head = getCurrentSystemMessage(current);`,
    "context-system-slots",
  );
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
    `            const current = getCurrentSystemMessage(transformed);
            const head = {
                role: "system",
                content: forced,
                ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
                timestamp: current?.timestamp ?? Date.now(),
            };
            return [head, ...transformed.filter((message) => message.role !== "system")];`,
    `            const firstIndex = transformed.findIndex((message) => message.role === "system");
            const first = firstIndex === -1 ? undefined : transformed[firstIndex];
            const head = {
                role: "system",
                content: forced,
                ...(first?.toolsAdded?.length ? { toolsAdded: first.toolsAdded } : {}),
                ...(first?.toolsRemoved?.length ? { toolsRemoved: first.toolsRemoved } : {}),
                timestamp: first?.timestamp ?? Date.now(),
            };
            const rest = [];
            for (let index = 0; index < transformed.length; index++) {
                const message = transformed[index];
                if (message.role !== "system") {
                    rest.push(message);
                    continue;
                }
                if (index === firstIndex || (!message.toolsAdded?.length && !message.toolsRemoved?.length))
                    continue;
                rest.push({
                    role: "system",
                    content: "",
                    ...(message.toolsAdded?.length ? { toolsAdded: message.toolsAdded } : {}),
                    ...(message.toolsRemoved?.length ? { toolsRemoved: message.toolsRemoved } : {}),
                    timestamp: message.timestamp,
                });
            }
            return [head, ...rest];`,
    "projection-tool-history",
  );
  next = replaceOnce(
    next,
    `    /**
     * Restore the active tool loadout declared by the session transcript, if it declares one.
`,
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
    /**
     * Restore the active tool loadout declared by the session transcript, if it declares one.
`,
    "compose-method",
  );
  next = replaceOnce(
    next,
    `        this._isAgentRunActive = true;
        try {
            await this.agent.prompt(messages);`,
    `        this._isAgentRunActive = true;
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
  patch("session-prompt:core/extensions/runner.js", "dist/core/extensions/runner.js", "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36", (source) => patchRunnerSystemSlots(patchRunner(source))),
  patch("session-prompt:core/agent-session.js", "dist/core/agent-session.js", "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab", patchAgentSession),
]);

export const files = Object.freeze([]);
export const sessionPromptFeature = Object.freeze({ id: "session-prompt", patches, files });
export const feature = sessionPromptFeature;
export default sessionPromptFeature;
