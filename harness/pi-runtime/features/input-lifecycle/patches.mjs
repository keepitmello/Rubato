import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";
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
    `    async prompt(text, options) {
        const expandPromptTemplates = options?.expandPromptTemplates ?? true;
        const preflightResult = options?.preflightResult;
        let messages;`,
    `    async prompt(text, options) {
        const expandPromptTemplates = options?.expandPromptTemplates ?? true;
        const preflightResult = options?.preflightResult;
        let messages;
        let inputId;`,
    "prompt-input-id",
  );
  next = replaceOnce(
    next,
    `            if (this._extensionRunner.hasHandlers("input")) {
                const inputResult = await this._extensionRunner.emitInput(currentText, currentImages, options?.source ?? "interactive", this.isStreaming ? options?.streamingBehavior : undefined);`,
    `            const inputSource = options?.source ?? "interactive";
            const streamingBehavior = this.isStreaming ? options?.streamingBehavior : undefined;
            inputId = this._inputLifecycle.begin({
                sessionId: this.sessionId,
                text: currentText,
                images: currentImages,
                source: inputSource,
                streamingBehavior,
            });
            if (this._extensionRunner.hasHandlers("input")) {
                const inputResult = await this._extensionRunner.emitInput(currentText, currentImages, inputSource, streamingBehavior, inputId);`,
    "prompt-input-event",
  );
  next = replaceOnce(
    next,
    `                if (inputResult.action === "handled") {
                    preflightResult?.(true);
                    return;
                }`,
    `                if (inputResult.action === "handled") {
                    await this._emitInputDisposition(inputId, "handled");
                    preflightResult?.(true);
                    return;
                }`,
    "prompt-handled",
  );
  next = replaceOnce(
    next,
    `                if (options.streamingBehavior === "followUp") {
                    await this._queueFollowUp(expandedText, currentImages);
                }
                else {
                    await this._queueSteer(expandedText, currentImages);
                }
                preflightResult?.(true);`,
    `                if (options.streamingBehavior === "followUp") {
                    await this._queueFollowUp(expandedText, currentImages, inputId);
                }
                else {
                    await this._queueSteer(expandedText, currentImages, inputId);
                }
                await this._emitInputDisposition(inputId, "queued");
                preflightResult?.(true);`,
    "prompt-queued",
  );
  next = replaceOnce(
    next,
    `            messages.push({
                role: "user",
                content: userContent,
                timestamp: Date.now(),
            });`,
    `            const userMessage = {
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
  next = replaceOnce(
    next,
    `                this.agent.state.systemPrompt = this._baseSystemPrompt;
            }
        }
        catch (error) {`,
    `                this.agent.state.systemPrompt = this._baseSystemPrompt;
            }
            await this._emitInputDisposition(inputId, "started");
        }
        catch (error) {`,
    "prompt-started",
  );
  next = replaceOnce(
    next,
    `        catch (error) {
            preflightResult?.(false);
            throw error;
        }
        if (!messages) {`,
    `        catch (error) {
            await this._emitInputDisposition(inputId, "rejected");
            preflightResult?.(false);
            throw error;
        }
        if (!messages) {`,
    "prompt-rejected",
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
        this.agent.followUp({
            role: "user",
            content,
            timestamp: Date.now(),
        });
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
    `    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
    /** Register a tool`,
    `    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
    on(event: "input_disposition", handler: ExtensionHandler<InputDispositionEvent>): void;
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
  patch("dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSessionRuntime),
  patch("dist/core/extensions/types.d.ts", "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "5e6f5e8e5dffccc0f7e235964a75ac181d2c6e06b924e149370ad688a31d7193", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "dc9bd3202b8d84b580d7002efad6738465c50556e2b27624193a6505b453c87d", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "f1cb93477c7357d08b839c0663d079b8f9bb949079ed7b50a71f8d2945cece90", patchPublicIndexTypes),
]);
