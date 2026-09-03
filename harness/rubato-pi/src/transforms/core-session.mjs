// [cluster:core-session] — compaction 시리즈, stream-watchdog, agent-session
// (/skill: inline, compact-after-user-abort), speculative, service-tier,
// pi-ai codex-overflow 를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw, 패치 공존 중 inert.

import { injectAgentSession, isAgentSessionUrl } from "./core-agent-session.mjs";
import { injectCompaction, isCompactionUrl } from "./core-compaction.mjs";
import { injectCompactionUtils, isCompactionUtilsUrl } from "./core-compaction-utils.mjs";
import { injectCoreDescriptors, isCoreDescriptorsUrl } from "./core-descriptors.mjs";
import { injectEmptyRecoveryLiveness, isEmptyRecoveryUrl } from "./core-empty-recovery.mjs";
import { injectErrorFormat, isErrorFormatUrl } from "./core-error-format.mjs";
import {
  injectCompactionIndexThreshold,
  injectCompactionPolicy,
  injectCompactionSettings,
  isCompactionIndexThresholdUrl,
  isCompactionPolicyUrl,
  isSettingsManagerUrl,
} from "./core-compaction-policy.mjs";
import { injectCompactionIndexReason, injectLanePolicy, isCompactionIndexUrl, isLanePolicyUrl } from "./core-lane-policy.mjs";
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
  if (isCompactionUtilsUrl(url)) source = applyTransform(source, injectCompactionUtils);
  if (isAgentSessionUrl(url)) source = applyTransform(source, injectAgentSession);
  if (isSpeculativeUrl(url)) source = applyTransform(source, injectSpeculative);
  if (isServiceTierUrl(url)) source = applyTransform(source, injectServiceTier);
  if (isOverflowUrl(url)) source = applyTransform(source, injectOverflow);
  if (isProviderTimeoutRetryUrl(url)) source = applyTransform(source, injectProviderTimeoutRetry);
  if (isErrorFormatUrl(url)) source = applyTransform(source, injectErrorFormat);
  if (isCoreDescriptorsUrl(url)) source = applyTransform(source, injectCoreDescriptors);
  if (isEmptyRecoveryUrl(url)) source = applyTransform(source, injectEmptyRecoveryLiveness);
  if (isLanePolicyUrl(url)) source = applyTransform(source, injectLanePolicy);
  if (isCompactionIndexUrl(url)) source = applyTransform(source, injectCompactionIndexReason);
  if (isCompactionIndexThresholdUrl(url)) source = applyTransform(source, injectCompactionIndexThreshold);
  if (isCompactionPolicyUrl(url)) source = applyTransform(source, injectCompactionPolicy);
  if (isSettingsManagerUrl(url)) source = applyTransform(source, injectCompactionSettings);
  return source;
}

export {
  injectAgentSession,
  injectCompaction,
  injectCompactionIndexReason,
  injectCompactionIndexThreshold,
  injectCompactionPolicy,
  injectCompactionSettings,
  injectCompactionUtils,
  injectCoreDescriptors,
  injectLanePolicy,
  injectEmptyRecoveryLiveness,
  injectErrorFormat,
  injectOverflow,
  injectProviderTimeoutRetry,
  injectServiceTier,
  injectSpeculative,
  injectStreamWatchdog,
  isAgentSessionUrl,
  isCompactionUrl,
  isCompactionIndexUrl,
  isCompactionIndexThresholdUrl,
  isCompactionPolicyUrl,
  isCompactionUtilsUrl,
  isSettingsManagerUrl,
  isLanePolicyUrl,
  isCoreDescriptorsUrl,
  isEmptyRecoveryUrl,
  isErrorFormatUrl,
  isOverflowUrl,
  isProviderTimeoutRetryUrl,
  isServiceTierUrl,
  isSpeculativeUrl,
  isStreamWatchdogUrl,
};
