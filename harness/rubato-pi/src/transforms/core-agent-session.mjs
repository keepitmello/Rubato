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

const LIVE_ARG_NEEDLE = "                abortActive: () => this.agent.abort(),\n                timeoutMs: retryTimeoutMs,\n            });";

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
export function injectAgentSession(source) {
  let next = replaceOnce(source, SKILL_NEEDLE, SKILL_REPLACEMENT, "inline /skill: pattern");
  next = replaceOnce(next, TOKEN_NEEDLE, TOKEN_REPLACEMENT, "inline /skill: tokens");
  next = replaceOnce(next, RETRY_NEEDLE, RETRY_REPLACEMENT, "compact after user abort");
  next = replaceOnce(next, ABORT_NEEDLE, ABORT_REPLACEMENT, "abortCompaction if running");
  next = replaceOnce(next, WAIT_NEEDLE, WAIT_REPLACEMENT, "_waitForIdleWithTimeout");
  next = replaceOnce(next, AWAIT1_NEEDLE, AWAIT1_REPLACEMENT, "await userAbortPromise bound");
  next = replaceOnce(next, AWAIT2_NEEDLE, AWAIT2_REPLACEMENT, "await abortPromise bound");
  next = replaceOnce(next, SYS_NEEDLE, SYS_REPLACEMENT, "manual compact abort bound");
  next = replaceOnce(next, LIVE_NEEDLE, LIVE_REPLACEMENT, "sawProviderLive");
  return replaceOnce(next, LIVE_ARG_NEEDLE, LIVE_ARG_REPLACEMENT, "isLive callback");
}
