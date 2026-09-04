import { replaceOnce } from "./core-replace.mjs";

const SKILL_NEEDLE = "const INLINE_DOLLAR_SKILL_INVOCATION_PATTERN = /(^|\\s)\\$skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\\s|$)/g;\n/**\n * Find explicit skill invocation tokens without treating ordinary inline dollar\n * prose (for example `$HOME`) as executable.\n *\n * Leading runs accept `/skill:name`, `$name`, and `$skill:name`. Outside the\n * leading run only the desktop's explicit `$skill:name` token is executable.\n */\n";

const SKILL_REPLACEMENT = "const INLINE_DOLLAR_SKILL_INVOCATION_PATTERN = /(^|\\s)([$\\/])skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\\s|$)/g;\n/**\n * Find explicit skill invocation tokens without treating ordinary inline dollar\n * prose (for example `$HOME`) as executable.\n *\n * Leading runs accept `/skill:name`, `$name`, and `$skill:name`. Outside the\n * leading run both explicit `$skill:name` and `/skill:name` are executable;\n * the bare `$name` shorthand stays leading-only so prose is not swallowed.\n */\n";

const TOKEN_NEEDLE = "        const start = (match.index ?? 0) + match[1].length;\n        tokens.push({\n            name: match[2],\n            syntax: \"dollar\",\n            start,\n            end: start + `$skill:${match[2]}`.length,\n            position: \"inline\",\n        });";

const TOKEN_REPLACEMENT = "        const start = (match.index ?? 0) + match[1].length;\n        const sigil = match[2];\n        tokens.push({\n            name: match[3],\n            syntax: sigil === \"/\" ? \"slash\" : \"dollar\",\n            start,\n            end: start + `${sigil}skill:${match[3]}`.length,\n            position: \"inline\",\n        });";

const RETRY_NEEDLE = "            if (!retryContinuationBlocked && !userAbortSuppressedQueuedContinuation) {\n                if (compactedBeforeRetry && this.agent.hasQueuedMessages()) {";

const RETRY_REPLACEMENT = "            if (!retryContinuationBlocked && userAbortSuppressedQueuedContinuation) {\n                // User abort must not skip a still-required compact. Codex turns can\n                // tool-loop past the window without ever emitting overflow, so the\n                // only way out used to be: Escape (which skipped compact) then a\n                // new prompt (which finally ran pre_prompt compact). Compact here\n                // without retrying the aborted turn.\n                if (requiredAutoCompaction) {\n                    await this._checkCompaction(msg, true, undefined, false);\n                }\n            }\n            else if (!retryContinuationBlocked && !userAbortSuppressedQueuedContinuation) {\n                if (compactedBeforeRetry && this.agent.hasQueuedMessages()) {";

const ABORT_NEEDLE = "        const shouldEmitAbort = !joinedAgentEndBoundary && !wasMidRun && (hadRetryBackoff || hadCompactionOrPending || hadClearedQueues);\n        this.abortCompaction();\n";

const ABORT_REPLACEMENT = "        const shouldEmitAbort = !joinedAgentEndBoundary && !wasMidRun && (hadRetryBackoff || hadCompactionOrPending || hadClearedQueues);\n        // `/compact` claims a controller and then waits for this abort. Cancelling\n        // that pending compact here is why Escape during a looping Codex turn made\n        // `/compact` look dead: the command aborted the turn *and* the compact it\n        // had just queued. Only cancel summarization that is already running.\n        if (this._compactionLifecycle.state.status === \"running\") {\n            this.abortCompaction();\n        }\n";

const WAIT_NEEDLE = "    async _abortActiveAgentAndRetry(source) {\n        this.abortRetry();";

const WAIT_REPLACEMENT = "    async _waitForIdleWithTimeout(timeoutMs) {\n        if (this.isIdle)\n            return true;\n        let timer;\n        try {\n            await Promise.race([\n                this.waitForIdle(),\n                new Promise((_, reject) => {\n                    timer = setTimeout(() => reject(new Error(\"idle-timeout\")), timeoutMs);\n                    timer.unref?.();\n                }),\n            ]);\n            return true;\n        }\n        catch (error) {\n            if (error instanceof Error && error.message === \"idle-timeout\")\n                return false;\n            throw error;\n        }\n        finally {\n            if (timer)\n                clearTimeout(timer);\n        }\n    }\n    async _abortActiveAgentAndRetry(source, idleTimeoutMs) {\n        this.abortRetry();";

const AWAIT1_NEEDLE = "            await this._userAbortPromise;\n            return;";

const AWAIT1_REPLACEMENT = "            if (idleTimeoutMs === undefined) {\n                await this._userAbortPromise;\n                return;\n            }\n            const settled = await this._waitForIdleWithTimeout(idleTimeoutMs);\n            if (!settled) {\n                throw new Error(\"Turn did not stop after abort; compaction cannot start until the current turn ends. Press Escape, then retry /compact.\");\n            }\n            return;";

const AWAIT2_NEEDLE = "        try {\n            await abortPromise;\n        }\n        finally {";

const AWAIT2_REPLACEMENT = "        try {\n            if (idleTimeoutMs === undefined) {\n                await abortPromise;\n                return;\n            }\n            const settled = await this._waitForIdleWithTimeout(idleTimeoutMs);\n            if (!settled) {\n                throw new Error(\"Turn did not stop after abort; compaction cannot start until the current turn ends. Press Escape, then retry /compact.\");\n            }\n        }\n        finally {";

const SYS_NEEDLE = "            // waitForIdle() depends on.\n            await this._abortActiveAgentAndRetry(\"system\");";

const SYS_REPLACEMENT = "            // waitForIdle() depends on. Bound the wait: Codex streams that ignore\n            // abort used to pin `/compact` forever.\n            await this._abortActiveAgentAndRetry(\"system\", 10_000);";

const LIVE_NEEDLE = "            if (this.agent.state.isStreaming)\n                return \"taken-over\";\n            await runBoundedRetryContinuation({";

const LIVE_REPLACEMENT = "            if (this.agent.state.isStreaming)\n                return \"taken-over\";\n            // Sticky: once the provider emits, keep the watchdog disarmed through\n            // tool rounds where isStreaming flickers false.\n            let sawProviderLive = false;\n            await runBoundedRetryContinuation({";

const LIVE_ARG_NEEDLE = "                abortActive: () => this.agent.abort(new ProviderRetryWatchdogAbortError(providerRetryWatchdogAbortMessage(retryTimeoutMs, this.agent.streamStartTimeoutMs))),\n                timeoutMs: retryTimeoutMs,\n            });";

const LIVE_ARG_REPLACEMENT = "                abortActive: () => this.agent.abort(),\n                timeoutMs: retryTimeoutMs,\n                isLive: () => {\n                    if (sawProviderLive)\n                        return true;\n                    if (this.agent.state.isStreaming) {\n                        sawProviderLive = true;\n                        return true;\n                    }\n                    return false;\n                },\n            });";

export function isAgentSessionUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/agent-session.js");
}

/**
 * Baseline inline /skill: + series #28 compact-after-user-abort + #31 isLive.
 *
 * @param {string} source
 * @returns {string}
 */
export function agentSessionHrefs() {
  return {
    tracker: new URL("./request-run-tracker.mjs", import.meta.url).href,
  };
}

export function injectAgentSession(source, hrefs = agentSessionHrefs()) {
  const trackerHref = hrefs.tracker ?? agentSessionHrefs().tracker;
  let next = replaceOnce(
    source,
    "import { randomUUID } from \"node:crypto\";\n",
    `import { randomUUID } from "node:crypto";\nimport { RequestRunTracker, createInputRecord, countImages, userMessageText } from ${JSON.stringify(trackerHref)};\n`,
    "request-run imports",
  );
  next = replaceOnce(next, SKILL_NEEDLE, SKILL_REPLACEMENT, "inline /skill: pattern");
  next = replaceOnce(next, TOKEN_NEEDLE, TOKEN_REPLACEMENT, "inline /skill: tokens");
  next = replaceOnce(next, RETRY_NEEDLE, RETRY_REPLACEMENT, "compact after user abort");
  next = replaceOnce(next, ABORT_NEEDLE, ABORT_REPLACEMENT, "abortCompaction if running");
  next = replaceOnce(next, WAIT_NEEDLE, WAIT_REPLACEMENT, "_waitForIdleWithTimeout");
  next = replaceOnce(next, AWAIT1_NEEDLE, AWAIT1_REPLACEMENT, "await userAbortPromise bound");
  next = replaceOnce(next, AWAIT2_NEEDLE, AWAIT2_REPLACEMENT, "await abortPromise bound");
  next = replaceOnce(next, SYS_NEEDLE, SYS_REPLACEMENT, "manual compact abort bound");
  next = replaceOnce(next, LIVE_NEEDLE, LIVE_REPLACEMENT, "sawProviderLive");
  next = replaceOnce(next, LIVE_ARG_NEEDLE, LIVE_ARG_REPLACEMENT, "isLive callback");
  next = replaceOnce(
    next,
    "        this._queuedInputOrder = [];\n        this._nextQueuedInputOrder = 0;",
    "        this._queuedInputOrder = [];\n        this._requestRunTracker = new RequestRunTracker();\n        this._preparedInteractiveInput = undefined;\n        this._nextQueuedInputOrder = 0;",
    "request-run ctor",
  );
  next = replaceOnce(
    next,
    "    _emitQueueUpdate() {\n        this._emit({\n            type: \"queue_update\",\n            steering: [...this._steeringMessages],\n            followUp: [...this._followUpMessages],\n            ordered: [...this._queuedInputOrder].sort((a, b) => a.enqueueOrder - b.enqueueOrder),\n        });\n    }",
    "    _emitQueueUpdate() {\n        this._emit({\n            type: \"queue_update\",\n            steering: [...this._steeringMessages],\n            followUp: [...this._followUpMessages],\n            ordered: [...this._queuedInputOrder].sort((a, b) => a.enqueueOrder - b.enqueueOrder),\n            pendingInputs: this._requestRunTracker?.snapshot().pendingInputs ?? [],\n        });\n    }",
    "queue_update pendingInputs",
  );
  next = replaceOnce(
    next,
    "        const message = {\n            role: \"user\",\n            content,\n            timestamp: Date.now(),\n        };\n        if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {\n            this._postCompactionDeferredSteeringMessages.push(message);",
    "        const message = {\n            role: \"user\",\n            content,\n            timestamp: Date.now(),\n        };\n        this._bindInteractiveInput(message, \"steer\", text, images);\n        if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {\n            this._postCompactionDeferredSteeringMessages.push(message);",
    "bind queued steer",
  );
  next = replaceOnce(
    next,
    "        const message = {\n            role: \"user\",\n            content,\n            timestamp: Date.now(),\n        };\n        if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {\n            this._postCompactionDeferredFollowUpMessages.push(message);",
    "        const message = {\n            role: \"user\",\n            content,\n            timestamp: Date.now(),\n        };\n        this._bindInteractiveInput(message, \"followUp\", text, images);\n        if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {\n            this._postCompactionDeferredFollowUpMessages.push(message);",
    "bind queued followUp",
  );
  next = replaceOnce(
    next,
    "            messages.push({\n                role: \"user\",\n                content: userContent,\n                timestamp: Date.now(),\n            });",
    "            messages.push({\n                role: \"user\",\n                content: userContent,\n                timestamp: Date.now(),\n            });\n            this._bindInteractiveInput(messages[0], \"submit\", expandedText, currentImages);",
    "bind immediate submit",
  );
  next = replaceOnce(
    next,
    "            }\n        }\n        const agentEndWillRetry = event.type === \"agent_end\" && this._willRetryAfterAgentEnd(event.messages);",
    "            }\n            this._observeRequestRunEvent(event);\n        }\n        else {\n            this._observeRequestRunEvent(event);\n        }\n        const agentEndWillRetry = event.type === \"agent_end\" && this._willRetryAfterAgentEnd(event.messages);",
    "observe request-run events",
  );
  next = replaceOnce(
    next,
    "            this._emit({ type: \"agent_settled\" });",
    "            this._requestRunTracker?.onAgentSettled();\n            this._emit({ type: \"agent_settled\" });",
    "complete on agent_settled",
  );
  next = replaceOnce(
    next,
    "        this._emit({ type: \"session_abort\" });",
    "        this._emit({ type: \"session_abort\" });\n        this._requestRunTracker?.onInterrupted();",
    "interrupt on session_abort",
  );
  next = replaceOnce(
    next,
    "    syncQueueModesFromSettings() {\n        this.agent.steeringMode = this.settingsManager.getSteeringMode();\n        this.agent.followUpMode = this.settingsManager.getFollowUpMode();\n    }",
    "    syncQueueModesFromSettings() {\n        this.agent.steeringMode = this.settingsManager.getSteeringMode();\n        this.agent.followUpMode = this.settingsManager.getFollowUpMode();\n        this._forceFollowUpMode();\n    }",
    "force followUpMode on sync",
  );
  next = replaceOnce(
    next,
    "    setFollowUpMode(mode) {\n        this.agent.followUpMode = mode;\n        this.settingsManager.setFollowUpMode(mode);\n        this._emitSessionSettingsChanged();\n    }",
    "    setFollowUpMode(mode) {\n        if (mode !== \"one-at-a-time\")\n            this._sessionLogger?.warn?.(\"followUpMode forced to one-at-a-time\", { requested: mode });\n        this.agent.followUpMode = \"one-at-a-time\";\n        this.settingsManager.setFollowUpMode(\"one-at-a-time\");\n        this._emitSessionSettingsChanged();\n    }",
    "force followUpMode setter",
  );
  next = replaceOnce(
    next,
    "    _resolveThresholdContextTokens(directContextTokens) {\n        const messages = filterContextExcludedMessages(this.agent.state.messages);\n        return resolveThresholdContextTokens(directContextTokens, estimateMessagesTokens(messages));\n    }",
    "    _resolveThresholdContextTokens(directContextTokens) {\n        const messages = filterContextExcludedMessages(this.agent.state.messages);\n        const estimate = estimateMessagesTokens(messages);\n        const resolved = resolveThresholdContextTokens(directContextTokens, estimate);\n        const window = this.model?.contextWindow ?? 0;\n        if (window > 0 && resolved > window && estimate > 0 && estimate <= window) {\n            return estimate;\n        }\n        return resolved;\n    }",
    "threshold tokens distrust billed-over-window",
  );
  next = replaceOnce(
    next,
    "        const estimate = estimateContextTokens(messages);\n        const percent = (estimate.tokens / contextWindow) * 100;\n        return {\n            tokens: estimate.tokens,\n            contextWindow,\n            percent,\n        };\n    }",
    "        const estimate = estimateContextTokens(messages);\n        let tokens = estimate.tokens;\n        if (tokens > contextWindow) {\n            const local = messages.reduce((sum, message) => sum + estimateTokens(message), 0);\n            if (local > 0 && local <= contextWindow) tokens = local;\n        }\n        const percent = (tokens / contextWindow) * 100;\n        return {\n            tokens,\n            contextWindow,\n            percent,\n        };\n    }",
    "getContextUsage distrust billed-over-window",
  );
  next = replaceOnce(
    next,
    "    /** Number of pending messages (includes both steering and follow-up) */\n",
    "    _bindInteractiveInput(message, delivery, text, images) {\n        const prepared = this._preparedInteractiveInput;\n        this._preparedInteractiveInput = undefined;\n        const resolved = prepared?.delivery ?? delivery;\n        const record = createInputRecord({\n            id: prepared?.id ?? randomUUID(),\n            delivery: resolved,\n            source: prepared?.source ?? \"unknown\",\n            text: text ?? userMessageText(message),\n            imageCount: Array.isArray(images) ? images.length : countImages(message?.content),\n            enqueuedAt: Date.now(),\n            targetRequestRunId: resolved === \"steer\" ? this._requestRunTracker?.activeRequestRunId : undefined,\n        });\n        this._requestRunTracker.attachRecord(message, record);\n        if (resolved === \"steer\" || resolved === \"followUp\")\n            this._requestRunTracker.enqueuePending(record);\n        this._lastInteractiveSubmit = {\n            inputId: record.id,\n            disposition: resolved === \"steer\" ? \"queued-steer\" : resolved === \"followUp\" ? \"queued-follow-up\" : \"started\",\n        };\n        return record;\n    }\n    prepareInteractiveInput(partial = {}) {\n        const requested = partial.delivery ?? \"auto\";\n        const delivery = requested === \"auto\"\n            ? (this.isStreaming ? \"followUp\" : \"submit\")\n            : (this.isStreaming ? requested : \"submit\");\n        this._preparedInteractiveInput = {\n            id: partial.id ?? randomUUID(),\n            delivery,\n            source: partial.source ?? \"unknown\",\n            text: partial.text ?? \"\",\n            imageCount: partial.imageCount ?? 0,\n        };\n        return this._preparedInteractiveInput;\n    }\n    takeInteractiveSubmitResult() {\n        const result = this._lastInteractiveSubmit;\n        this._lastInteractiveSubmit = undefined;\n        return result;\n    }\n    getInteractiveInput(message) {\n        return this._requestRunTracker?.getRecord(message);\n    }\n    updateQueuedInputDelivery(message, delivery) {\n        return this._requestRunTracker?.updatePendingDelivery(message, delivery);\n    }\n    clearPendingInteractiveInputs() {\n        const cleared = this._requestRunTracker?.clearPendingInputs() ?? { clearedIds: [] };\n        this.clearQueue();\n        return cleared;\n    }\n    requestTimelineSnapshot() {\n        return this._requestRunTracker?.snapshot() ?? {\n            schemaVersion: 1,\n            runs: [],\n            pendingInputs: [],\n            hasOlder: false,\n        };\n    }\n    async readConversationPage(input = {}) {\n        if (this._requestRunTracker && this._requestRunTracker.entries.length === 0) {\n            this._requestRunTracker.rebuildFromMessages(this.agent?.state?.messages ?? []);\n        }\n        return this._requestRunTracker.readConversationPage(input);\n    }\n    _observeRequestRunEvent(event) {\n        this._requestRunTracker?.observe(event);\n    }\n    _forceFollowUpMode() {\n        if (this.agent && this.agent.followUpMode !== \"one-at-a-time\") {\n            this._sessionLogger?.warn?.(\"followUpMode forced to one-at-a-time\", { requested: this.agent.followUpMode });\n        }\n        if (this.agent)\n            this.agent.followUpMode = \"one-at-a-time\";\n    }\n    /** Number of pending messages (includes both steering and follow-up) */\n",
    "request-run session methods",
  );
  return next;
}
