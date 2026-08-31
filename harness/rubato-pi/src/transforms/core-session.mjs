// [cluster:core-session] — compaction 시리즈, stream-watchdog, agent-session
// (/skill: inline, compact-after-user-abort), speculative, service-tier,
// pi-ai codex-overflow 를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw, 패치 공존 중 inert.

import { injectAgentSession, isAgentSessionUrl } from "./core-agent-session.mjs";
import { injectCompaction, isCompactionUrl } from "./core-compaction.mjs";
import { injectCoreDescriptors, isCoreDescriptorsUrl } from "./core-descriptors.mjs";
import { injectErrorFormat, isErrorFormatUrl } from "./core-error-format.mjs";
import { injectOverflow, isOverflowUrl } from "./core-overflow.mjs";
import { injectProviderTimeoutRetry, isProviderTimeoutRetryUrl } from "./core-retry-watchdog.mjs";
import { injectServiceTier, isServiceTierUrl } from "./core-service-tier.mjs";
import { injectSpeculative, isSpeculativeUrl } from "./core-speculative.mjs";
import { injectStreamWatchdog, isStreamWatchdogUrl } from "./core-stream-watchdog.mjs";

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyCoreSessionTransforms(url, source, applyTransform) {
  if (isStreamWatchdogUrl(url)) source = applyTransform(source, injectStreamWatchdog);
  if (isCompactionUrl(url)) source = applyTransform(source, injectCompaction);
  if (isAgentSessionUrl(url)) source = applyTransform(source, injectAgentSession);
  if (isSpeculativeUrl(url)) source = applyTransform(source, injectSpeculative);
  if (isServiceTierUrl(url)) source = applyTransform(source, injectServiceTier);
  if (isOverflowUrl(url)) source = applyTransform(source, injectOverflow);
  if (isProviderTimeoutRetryUrl(url)) source = applyTransform(source, injectProviderTimeoutRetry);
  if (isErrorFormatUrl(url)) source = applyTransform(source, injectErrorFormat);
  if (isCoreDescriptorsUrl(url)) source = applyTransform(source, injectCoreDescriptors);
  return source;
}

export {
  injectAgentSession,
  injectCompaction,
  injectCoreDescriptors,
  injectErrorFormat,
  injectOverflow,
  injectProviderTimeoutRetry,
  injectServiceTier,
  injectSpeculative,
  injectStreamWatchdog,
  isAgentSessionUrl,
  isCompactionUrl,
  isCoreDescriptorsUrl,
  isErrorFormatUrl,
  isOverflowUrl,
  isProviderTimeoutRetryUrl,
  isServiceTierUrl,
  isSpeculativeUrl,
  isStreamWatchdogUrl,
};
