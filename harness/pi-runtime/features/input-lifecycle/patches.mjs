import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as PACKAGE_VERSION } from "../../pi-version.mjs";
const FEATURE_IMPORT = 'import { InputLifecycle } from "../rubato-features/input-lifecycle/state.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[input-lifecycle:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[input-lifecycle:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[input-lifecycle:${label}] expected anchor is missing (already patched)`);
  }
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `input-lifecycle:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchAgentSessionRuntime(source) {
  unpatched(source, FEATURE_IMPORT, "agent-session");
  let next = replaceOnce(
    source,
    'import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";',
    `import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";\n${FEATURE_IMPORT}`,
    "session-import",
  );
  next = replaceOnce(
    next,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    /** Messages queued to be included with the next user prompt as context ("asides"). */`,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    _inputLifecycle = new InputLifecycle();
    /** Messages queued to be included with the next user prompt as context ("asides"). */`,
    "session-state",
  );
  next = replaceOnce(
    next,
    `            const messageText = contentText(event.message.content, "");
            if (messageText) {
                // Check steering queue first
                const steeringIndex = this._steeringMessages.indexOf(messageText);
                if (steeringIndex !== -1) {
                    this._steeringMessages.splice(steeringIndex, 1);
                    this._emitQueueUpdate();
                }
                else {
                    // Check follow-up queue
                    const followUpIndex = this._followUpMessages.indexOf(messageText);
                    if (followUpIndex !== -1) {
                        this._followUpMessages.splice(followUpIndex, 1);
                        this._emitQueueUpdate();
                    }
                }
            }`,
    `            const queuedInput = this._inputLifecycle.takeQueuedMessage(event.message);
            const messageText = queuedInput?.text ?? contentText(event.message.content, "");
            if (messageText) {
                const queue = queuedInput?.delivery === "followUp" ? this._followUpMessages : this._steeringMessages;
                const queuedIndex = queue.indexOf(messageText);
                if (queuedIndex !== -1) {
                    queue.splice(queuedIndex, 1);
                    this._emitQueueUpdate();
                }
                else if (!queuedInput) {
                    // Preserve stock compatibility for messages queued directly on Agent.
                    const followUpIndex = this._followUpMessages.indexOf(messageText);
                    if (followUpIndex !== -1) {
                        this._followUpMessages.splice(followUpIndex, 1);
                        this._emitQueueUpdate();
                    }
                }
            }`,
    "queue-consume-identity",
  );
  next = replaceOnce(
    next,
    // 1.0 removed upstream's preflight try/catch (RPC now reports a thrown
    // prompt itself), so the "rejected" disposition needs its own try. It spans
    // the whole body; \`inputStarted\` keeps run-time failures after "started"
    // from being reported as rejections, exactly like the old preflight scope.
    `    async prompt(text, options) {
        if (this._isEmittingAgentSettled) {
            this._deferredSettledActions.push(async () => await this.prompt(text, options));
            return;
        }
        const expandPromptTemplates = options?.expandPromptTemplates ?? true;
        const preflightResult = options?.preflightResult;
`,
    `    async prompt(text, options) {
        if (this._isEmittingAgentSettled) {
            this._deferredSettledActions.push(async () => await this.prompt(text, options));
            return;
        }
        const expandPromptTemplates = options?.expandPromptTemplates ?? true;
        const preflightResult = options?.preflightResult;
        let inputId;
        let inputStarted = false;
        try {
`,
    "prompt-input-id",
  );
  next = replaceOnce(
    next,
    `        const processedInput = await this._runInputHandlers(text, options?.images, options?.source ?? "interactive", this.isStreaming ? options?.streamingBehavior : undefined);
        if (!processedInput) {
            preflightResult?.("handled");
            return;
        }
        const { text: currentText, images: currentImages } = processedInput;`,
    `        const processedInput = await this._runInputHandlers(text, options?.images, options?.source ?? "interactive", this.isStreaming ? options?.streamingBehavior : undefined);
        if (!processedInput) {
            preflightResult?.("handled");
            return;
        }
        const { text: currentText, images: currentImages } = processedInput;
        inputId = processedInput.inputId;`,
    "prompt-input-id-binding",
  );
  // 0.86 moved the `input` emission into the shared `_runInputHandlers` helper that both
  // `prompt()` and `_queueUserInput()` call, so the old inline emission is gone. The intent
  // is unchanged: every input gets an id at admission, that id rides the `input` event, and
  // the helper owns the terminal "handled" disposition because it owns the handling decision.
  next = replaceOnce(
    next,
    `    async _runInputHandlers(text, images, source, streamingBehavior) {
        if (!this._extensionRunner.hasHandlers("input")) {
            return { text, images };
        }
        const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
        if (inputResult.action === "handled") {
            return undefined;
        }
        if (inputResult.action === "transform") {
            return { text: inputResult.text, images: inputResult.images ?? images };
        }
        return { text, images };
    }`,
    `    async _runInputHandlers(text, images, source, streamingBehavior) {
        const inputId = this._inputLifecycle.begin({
            sessionId: this.sessionId,
            text,
            images,
            source,
            streamingBehavior,
        });
        if (!this._extensionRunner.hasHandlers("input")) {
            return { text, images, inputId };
        }
        const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior, inputId);
        if (inputResult.action === "handled") {
            await this._emitInputDisposition(inputId, "handled");
            return undefined;
        }
        if (inputResult.action === "transform") {
            return { text: inputResult.text, images: inputResult.images ?? images, inputId };
        }
        return { text, images, inputId };
    }`,
    "input-handlers-lifecycle",
  );
  // `steer()`/`followUp()` now reach the same seam as `prompt()`, so they are inputs too:
  // without an id their queued message would fall back to stock string-identity removal,
  // which is exactly the defect this feature exists to remove.
  next = replaceOnce(
    next,
    `    async _queueUserInput(text, images, behavior, source) {
        if (text.startsWith("/")) {
            this._throwIfExtensionCommand(text);
        }
        const processedInput = await this._runInputHandlers(text, images, source, this.isStreaming ? behavior : undefined);
        if (!processedInput)
            return "handled";
        let expandedText = this._expandSkillCommand(processedInput.text);
        expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
        if (behavior === "steer") {
            await this._queueSteer(expandedText, processedInput.images);
        }
        else {
            await this._queueFollowUp(expandedText, processedInput.images);
        }
        return "queued";
    }`,
    `    async _queueUserInput(text, images, behavior, source) {
        if (text.startsWith("/")) {
            this._throwIfExtensionCommand(text);
        }
        const processedInput = await this._runInputHandlers(text, images, source, this.isStreaming ? behavior : undefined);
        if (!processedInput)
            return "handled";
        let expandedText = this._expandSkillCommand(processedInput.text);
        expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
        if (behavior === "steer") {
            await this._queueSteer(expandedText, processedInput.images, processedInput.inputId);
        }
        else {
            await this._queueFollowUp(expandedText, processedInput.images, processedInput.inputId);
        }
        await this._emitInputDisposition(processedInput.inputId, "queued");
        return "queued";
    }`,
    "queue-user-input-lifecycle",
  );
  next = replaceOnce(
    next,
    `            if (options.streamingBehavior === "followUp") {
                await this._queueFollowUp(expandedText, currentImages);
            }
            else {
                await this._queueSteer(expandedText, currentImages);
            }
            preflightResult?.("queued");`,
    `            if (options.streamingBehavior === "followUp") {
                await this._queueFollowUp(expandedText, currentImages, inputId);
            }
            else {
                await this._queueSteer(expandedText, currentImages, inputId);
            }
            await this._emitInputDisposition(inputId, "queued");
            preflightResult?.("queued");`,
    "prompt-queued",
  );
  next = replaceOnce(
    next,
    `        messages.push({
            role: "user",
            content: userContent,
            timestamp: Date.now(),
        });`,
    `        const userMessage = {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
        };
        this._inputLifecycle.bindMessage(inputId, userMessage, {
            delivery: "submit",
            text: expandedText,
            images: currentImages,
        });
        messages.push(userMessage);`,
    "prompt-message-identity",
  );
  // 0.86 renders the system prompt from options instead of assigning
  // `agent.state.systemPrompt`, so the old tail anchor is gone; the disposition
  // still belongs at the point where the prompt is definitely about to run.
  next = replaceOnce(
    next,
    `        preflightResult?.("started");
        await this._runAgentPrompt(messages);
    }`,
    `        await this._emitInputDisposition(inputId, "started");
        inputStarted = true;
        preflightResult?.("started");
        await this._runAgentPrompt(messages);
        }
        catch (error) {
            if (!inputStarted)
                await this._emitInputDisposition(inputId, "rejected");
            throw error;
        }
    }`,
    "prompt-started",
  );
  next = replaceOnce(
    next,
    `    /**
     * Try to execute an extension command. Returns true if command was found and executed.
     */
    async _tryExecuteExtensionCommand(text) {`,
    `    async _emitInputDisposition(inputId, disposition) {
        const event = this._inputLifecycle.settle(inputId, disposition);
        if (event) {
            await this._extensionRunner.emit(event);
        }
    }
    /**
     * Try to execute an extension command. Returns true if command was found and executed.
     */
    async _tryExecuteExtensionCommand(text) {`,
    "disposition-emitter",
  );
  next = replaceOnce(
    next,
    `    async _queueSteer(text, images) {
        this._steeringMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        this.agent.steer({
            role: "user",
            content,
            timestamp: Date.now(),
        });
    }`,
    `    async _queueSteer(text, images, inputId) {
        this._steeringMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "steer",
            text,
            images,
            pending: true,
        });
        this.agent.steer(message);
    }`,
    "queue-steer-bind",
  );
  next = replaceOnce(
    next,
    `    async _queueFollowUp(text, images) {
        this._followUpMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        this.agent.followUp({ role: "user", content, timestamp: Date.now() });
    }`,
    `    async _queueFollowUp(text, images, inputId) {
        this._followUpMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "followUp",
            text,
            images,
            pending: true,
        });
        this.agent.followUp(message);
    }`,
    "queue-followup-bind",
  );
  next = replaceOnce(
    next,
    `        this._steeringMessages = [];
        this._followUpMessages = [];
        this.agent.clearAllQueues();`,
    `        this._steeringMessages = [];
        this._followUpMessages = [];
        this._inputLifecycle.clearQueuedMessages();
        this.agent.clearAllQueues();`,
    "queue-clear-identity",
  );
  return next;
}

function patchExtensionTypes(source) {
  unpatched(source, "export interface InputDispositionEvent", "extension-types");
  let next = replaceOnce(
    source,
    `export interface InputEvent {
    type: "input";
    /** The input text */`,
    `export interface InputEvent {
    type: "input";
    /** Correlates this input with its terminal disposition in this session. */
    inputId: string;
    /** The input text */`,
    "types-input-id",
  );
  next = replaceOnce(
    next,
    `    streamingBehavior?: "steer" | "followUp";
}
/** Result from input event handler */`,
    `    streamingBehavior?: "steer" | "followUp";
}
/** Fired exactly once after interception and admission determine input ownership. */
export interface InputDispositionEvent {
    type: "input_disposition";
    inputId: string;
    disposition: "handled" | "queued" | "started" | "rejected";
}
/** Result from input event handler */`,
    "types-disposition-event",
  );
  next = replaceOnce(
    next,
    "| UserBashEvent | InputEvent | ToolCallEvent | ToolResultEvent;",
    "| UserBashEvent | InputEvent | InputDispositionEvent | ToolCallEvent | ToolResultEvent;",
    "types-extension-union",
  );
  next = replaceOnce(
    next,
    `    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
    /** Register a tool`,
    `    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
    on(event: "input_disposition", handler: ExtensionHandler<InputDispositionEvent>): () => void;
    /** Register a tool`,
    "types-api-overload",
  );
  return next;
}

function patchRunnerRuntime(source) {
  unpatched(source, "inputId,\n                    text: currentText", "runner-runtime");
  let next = replaceOnce(
    source,
    "    async emitInput(text, images, source, streamingBehavior) {",
    "    async emitInput(text, images, source, streamingBehavior, inputId) {",
    "runner-signature",
  );
  next = replaceOnce(
    next,
    `                    const event = {
                        type: "input",
                        text: currentText,`,
    `                    const event = {
                        type: "input",
                        inputId,
                        text: currentText,`,
    "runner-event-id",
  );
  return next;
}

function patchRunnerTypes(source) {
  unpatched(source, "streamingBehavior: \"steer\" | \"followUp\" | undefined, inputId: string", "runner-types");
  return replaceOnce(
    source,
    `    emitInput(text: string, images: ImageContent[] | undefined, source: InputSource, streamingBehavior?: "steer" | "followUp"): Promise<InputEventResult>;`,
    `    emitInput(text: string, images: ImageContent[] | undefined, source: InputSource, streamingBehavior: "steer" | "followUp" | undefined, inputId: string): Promise<InputEventResult>;`,
    "runner-types-signature",
  );
}

function patchExtensionIndexTypes(source) {
  unpatched(source, "InputDispositionEvent", "extension-index-types");
  return replaceOnce(
    source,
    "InlineExtension, InputEvent, InputEventResult, InputSource, KeybindingsManager",
    "InlineExtension, InputDispositionEvent, InputEvent, InputEventResult, InputSource, KeybindingsManager",
    "extension-index-export",
  );
}

function patchPublicIndexTypes(source) {
  unpatched(source, "InputDispositionEvent", "public-index-types");
  return replaceOnce(
    source,
    "InlineExtension, InputEvent, InputEventResult, InputSource, KeybindingsManager",
    "InlineExtension, InputDispositionEvent, InputEvent, InputEventResult, InputSource, KeybindingsManager",
    "public-index-export",
  );
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/input-lifecycle/state.mjs",
    sourcePath: fileURLToPath(new URL("./state.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("dist/core/agent-session.js", "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab", patchAgentSessionRuntime),
  patch("dist/core/extensions/types.d.ts", "abd9e9be0bf21b4c35621fe90b79af75c85b774e8b254b515d699785fda5962a", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "6aef77e094e73abd7e508850e45c58e244ab2d5db6c4f6278d8652ea9ded2bb1", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "fe5661c6cd9a948293f0f1d1db5a052dcc60493f6b1f68349a7ab96987b10e40", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "b254e36846b1dcc64ce1a8ba72e23fb410df4aa4408ba8c23e69e5b3f934e3cc", patchPublicIndexTypes),
]);
