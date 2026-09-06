// [cluster:core-session] — compaction 시리즈, stream-watchdog, agent-session
// (/skill: inline, compact-after-user-abort), speculative, service-tier,
// pi-ai codex-overflow, convertToLlm hidden-custom remap 를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw, 패치 공존 중 inert.

import { injectAgentSession, injectEvalOnlyDirectTools, isAgentSessionUrl } from "./core-agent-session.mjs";
import {
  injectToolSurface, injectUniversalApplyPatch, isApplyPatchExtensionUrl,
  injectMcpSearchExposure, isMcpTierBUrl, injectDeferredMediaTool, isModelGatedMediaUrl,
  injectMcpCatalogOwnership, isToolSearchServiceUrl,
} from "./core-tool-surface.mjs";
import { injectToolDescriptions, isToolDefinitionWrapperUrl } from "./core-tool-descriptions.mjs";
import { injectCompaction, injectContextTokensGuard, isCompactionUrl, isContextTokensUrl } from "./core-compaction.mjs";
import { injectCompactionUtils, isCompactionUtilsUrl } from "./core-compaction-utils.mjs";
import {
  injectCompactionContextPipeline,
  injectCompactionOverflowRetry,
  isCompactionContextPipelineUrl,
  isCompactionOverflowRetryUrl,
} from "./core-compaction-prune.mjs";
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
import { injectMessages, isMessagesUrl } from "./core-messages.mjs";
import { injectRoutineSettings, isRoutineSettingsUrl } from "./core-routine-settings.mjs";
import { injectSessionPersist, isSessionManagerUrl } from "./core-session-persist.mjs";
import { injectResumeUsabilityBudget, isSdkUrl } from "./core-session-resume-budget.mjs";
import {
  injectInteractiveSessionListPage,
  injectMainSessionListPage,
  injectSessionDiscoveryPage,
  injectSessionManagerPage,
  injectSessionSelectorPage,
  isBootMainSessionListUrl,
  isInteractiveModeSessionListUrl,
  isSessionDiscoveryUrl,
  isSessionSelectorUrl,
} from "./core-session-list-page.mjs";
import { injectStreamWatchdog, isStreamWatchdogUrl } from "./core-stream-watchdog.mjs";
import {
  injectEvalOnlyRouting, injectTerminalExtension, injectTerminalPrompt,
  isEvalOnlyRoutingUrl, isTerminalExtensionUrl, isTerminalPromptUrl,
} from "./core-terminal-routing.mjs";

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyCoreSessionTransforms(url, source, applyTransform) {
  if (isStreamWatchdogUrl(url)) source = applyTransform(source, injectStreamWatchdog);
  if (isCompactionUrl(url)) source = applyTransform(source, injectCompaction);
  if (isContextTokensUrl(url)) source = applyTransform(source, injectContextTokensGuard);
  if (isCompactionUtilsUrl(url)) source = applyTransform(source, injectCompactionUtils);
  if (isCompactionContextPipelineUrl(url)) source = applyTransform(source, injectCompactionContextPipeline);
  if (isCompactionOverflowRetryUrl(url)) source = applyTransform(source, injectCompactionOverflowRetry);
  if (isAgentSessionUrl(url)) {
    source = applyTransform(source, injectAgentSession);
    source = applyTransform(source, injectEvalOnlyDirectTools);
    source = applyTransform(source, injectToolSurface);
  }
  if (isApplyPatchExtensionUrl(url)) source = applyTransform(source, injectUniversalApplyPatch);
  if (isMcpTierBUrl(url)) source = applyTransform(source, injectMcpSearchExposure);
  if (isToolSearchServiceUrl(url)) source = applyTransform(source, injectMcpCatalogOwnership);
  if (isModelGatedMediaUrl(url)) source = applyTransform(source, injectDeferredMediaTool);
  if (isToolDefinitionWrapperUrl(url)) source = applyTransform(source, injectToolDescriptions);
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
  if (isSessionManagerUrl(url)) {
    source = applyTransform(source, injectSessionPersist);
    source = applyTransform(source, injectSessionManagerPage);
  }
  if (isSessionDiscoveryUrl(url)) source = applyTransform(source, injectSessionDiscoveryPage);
  if (isSessionSelectorUrl(url)) source = applyTransform(source, injectSessionSelectorPage);
  if (isInteractiveModeSessionListUrl(url)) source = applyTransform(source, injectInteractiveSessionListPage);
  if (isBootMainSessionListUrl(url)) source = applyTransform(source, injectMainSessionListPage);
  if (isSdkUrl(url)) source = applyTransform(source, injectResumeUsabilityBudget);
  if (isMessagesUrl(url)) source = applyTransform(source, injectMessages);
  if (isRoutineSettingsUrl(url)) source = applyTransform(source, injectRoutineSettings);
  if (isEvalOnlyRoutingUrl(url)) source = applyTransform(source, injectEvalOnlyRouting);
  if (isTerminalExtensionUrl(url)) source = applyTransform(source, injectTerminalExtension);
  if (isTerminalPromptUrl(url)) source = applyTransform(source, injectTerminalPrompt);
  return source;
}

export {
  injectAgentSession,
  injectEvalOnlyDirectTools,
  injectEvalOnlyRouting,
  injectTerminalExtension,
  injectTerminalPrompt,
  injectCompaction,
  injectContextTokensGuard,
  injectCompactionIndexReason,
  injectCompactionIndexThreshold,
  injectCompactionPolicy,
  injectCompactionSettings,
  injectCompactionUtils,
  injectCompactionContextPipeline,
  injectCompactionOverflowRetry,
  injectCoreDescriptors,
  injectLanePolicy,
  injectMessages,
  injectEmptyRecoveryLiveness,
  injectErrorFormat,
  injectOverflow,
  injectProviderTimeoutRetry,
  injectServiceTier,
  injectSessionPersist,
  injectSpeculative,
  injectStreamWatchdog,
  isAgentSessionUrl,
  isEvalOnlyRoutingUrl,
  isTerminalExtensionUrl,
  isTerminalPromptUrl,
  isCompactionUrl,
  isContextTokensUrl,
  isCompactionIndexUrl,
  isCompactionIndexThresholdUrl,
  isCompactionPolicyUrl,
  isCompactionUtilsUrl,
  isCompactionContextPipelineUrl,
  isCompactionOverflowRetryUrl,
  isSettingsManagerUrl,
  isLanePolicyUrl,
  isMessagesUrl,
  isCoreDescriptorsUrl,
  isEmptyRecoveryUrl,
  isErrorFormatUrl,
  isOverflowUrl,
  isProviderTimeoutRetryUrl,
  isServiceTierUrl,
  isSessionManagerUrl,
  isSpeculativeUrl,
  isStreamWatchdogUrl,
};
