import { replaceOnce } from "./core-replace.mjs";

const HELPERS_NEEDLE = "const FAST_ARGUMENTS = [\"on\", \"off\"];\nconst FAST_USAGE = \"Usage: /fast [on|off]\";";

/**
 * Anthropic fast mode 은 service tier 가 아니다. 같은 hook 안에 사는 두 번째 배선이다.
 *
 * wire 가 다르다: `service_tier` 대신 요청 본문의 `speed: "fast"` 와 beta
 * `fast-mode-2026-02-01` 를 함께 보낸다(SDK 가 `betas` 배열을 `anthropic-beta` 헤더로
 * 바꾼다). 모델 허용 목록이 좁은 것도 tier 와 다른 점이다: Opus 5 / 4.8 만 받고
 * Opus 4.7 은 이 필드를 400 으로 거절하며 4.6 은 조용히 표준 속도로 과금한다.
 * 그래서 provider 검사가 아니라 스냅샷 id 허용 목록이다.
 *
 * gateway 를 통과하는 `anthropic-messages` (copilot, kiro) 는 fast 를 제공하지 않는다.
 * cache-audit 이 쓰는 것과 같은 "진짜 Anthropic 직결" 판정을 재사용한다.
 */
const HELPERS_REPLACEMENT = `const FAST_ARGUMENTS = ["on", "off"];
const FAST_USAGE = "Usage: /fast [on|off]";
const ANTHROPIC_MESSAGES_API = "anthropic-messages";
const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_SPEED = "fast";
const ANTHROPIC_FAST_MODEL_ID = /^claude-opus-(?:5|4-8)(?:-\\d{8})?$/;
function isAnthropicFastModel(model) {
    if (model?.api !== ANTHROPIC_MESSAGES_API) {
        return false;
    }
    if (model.provider !== "anthropic" && !/api\\.anthropic\\.com/.test(String(model.baseUrl ?? ""))) {
        return false;
    }
    const modelId = String(model.upstreamModelId ?? model.id ?? "").toLowerCase();
    return ANTHROPIC_FAST_MODEL_ID.test(modelId);
}
function supportsFastMode(model) {
    return model?.api === OPENAI_CODEX_RESPONSES_API || model?.provider === "xai" || isAnthropicFastModel(model);
}
function applyAnthropicFastMode(payload, enabled) {
    if (!enabled || !isRecord(payload) || payload.speed !== undefined) {
        return payload;
    }
    const betas = Array.isArray(payload.betas) ? payload.betas : [];
    return {
        ...payload,
        speed: ANTHROPIC_FAST_SPEED,
        betas: betas.includes(ANTHROPIC_FAST_BETA) ? betas : [...betas, ANTHROPIC_FAST_BETA],
    };
}`;

const BOOT_NEEDLE = "        // The flag is derived from the POST-swap model: a `-fast` catalog variant swaps down to\n        // its base before this reads `ctx.serviceTier`, so inheritance is judged on the model the\n        // user actually ends up on.\n        const remembered = getRememberedServiceTier(settingsManager, ctx.modelRegistry, model);\n        const baseModel = findBaseModel(ctx.modelRegistry, model);\n        if (baseModel) {\n            await pi.setSessionModel(baseModel);\n        }\n        sessionFastMode = remembered === PRIORITY_TIER || (remembered === undefined && ctx.serviceTier === PRIORITY_TIER);\n        pi.setSessionFastMode(sessionFastMode);";

const BOOT_REPLACEMENT = "        // A remembered priority means the selected `-fast` catalog identity is itself the user's\n        // persisted default. Preserve that exact identity across startup; only normalize to the\n        // base model when an explicit remembered non-priority tier turns fast mode off.\n        const remembered = getRememberedServiceTier(settingsManager, ctx.modelRegistry, model);\n        const baseModel = findBaseModel(ctx.modelRegistry, model);\n        sessionFastMode = remembered === PRIORITY_TIER || (remembered === undefined && ctx.serviceTier === PRIORITY_TIER);\n        if (baseModel && !sessionFastMode) {\n            await pi.setSessionModel(baseModel);\n        }\n        pi.setSessionFastMode(sessionFastMode);";

const SELECT_NEEDLE = "    pi.on(\"model_select\", (event, ctx) => {\n        // A model switch changes the base key the memory lives under, so the live tier is RE-DERIVED\n        // for the incoming model instead of merely dropped: dropping it would leave a remembered\n        // \"auto\" unable to suppress a catalog-inherited priority after switching away and back in one\n        // session, silently re-sending the tier `/fast off` turned off. Per-key scoping is preserved —\n        // each model reads ITS OWN memory, never the previous model's.\n        const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });\n        const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, event.model);\n        liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;\n        liveMemoryTier = getRememberedServiceTier(settingsManager, ctx.modelRegistry, event.model);\n        // `service_tier` is an OpenAI-family request field, so hopping to a non-Codex model leaves the\n        // intent with nothing to act on: `before_provider_request` already refuses to emit the tier\n        // there, but the session flag kept `isFastModeActive()` (and with it the RPC `fastMode` and the\n        // lightning indicator) claiming fast for a model that can never be served at that tier.\n        //\n        // Codex -> Codex is deliberately untouched: fast mode is a SESSION intent that survives a\n        // mid-session Codex switch (see service-tier-extension.test.ts \"keeps session fast mode on\n        // across a mid-session switch to another Codex model\"), and an incoming model's remembered\n        // \"auto\" is honored on the wire by `liveMemoryTier` below, not by clearing the flag here.\n        if (sessionFastMode && event.model.api !== OPENAI_CODEX_RESPONSES_API) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n        }\n    });\n";

const SELECT_REPLACEMENT = "    pi.on(\"model_select\", async (event, ctx) => {\n        // A model switch changes the base key the memory lives under, so the live tier is RE-DERIVED\n        // for the incoming model instead of merely dropped: dropping it would leave a remembered\n        // \"auto\" unable to suppress a catalog-inherited priority after switching away and back in one\n        // session, silently re-sending the tier `/fast off` turned off. Per-key scoping is preserved —\n        // each model reads ITS OWN memory, never the previous model's.\n        const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });\n        const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, event.model);\n        liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;\n        liveMemoryTier = getRememberedServiceTier(settingsManager, ctx.modelRegistry, event.model);\n        // Choosing a catalog `-fast` model is an explicit fast-mode choice, even when an older\n        // `/fast off` memory exists for its base model. Persist the choice on the shared base key\n        // so a fresh session restores the exact fast identity instead of immediately swapping down.\n        if ((event.source === \"set\" || event.source === \"cycle\") && findBaseModel(ctx.modelRegistry, event.model)) {\n            settingsManager.setModelServiceTier(memoryModel.provider, memoryModel.id, PRIORITY_TIER);\n            await settingsManager.flush();\n            liveMemoryTier = PRIORITY_TIER;\n            sessionFastMode = true;\n            pi.setSessionFastMode(true);\n        }\n        // Fast mode follows the model in BOTH directions. Switching to a model that cannot be served\n        // fast turns the session flag off: the wire gate already refuses to stamp the request, but a\n        // live flag would keep the lightning indicator promising a speed nothing delivers — and on\n        // Anthropic an unsupported Opus would take a hard 400 rather than a silent downgrade.\n        // Switching back to a fast-capable model restores the flag from THAT model's own memory.\n        if (sessionFastMode && !supportsFastMode(event.model)) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n        }\n        else if (!sessionFastMode && liveMemoryTier === PRIORITY_TIER && isAnthropicFastModel(event.model)) {\n            sessionFastMode = true;\n            pi.setSessionFastMode(true);\n        }\n    });\n";

const APIS_NEEDLE = "const SERVICE_TIER_APIS = new Set([\"openai-responses\", OPENAI_CODEX_RESPONSES_API]);";
const APIS_REPLACEMENT = "const SERVICE_TIER_APIS = new Set([\"openai-responses\", OPENAI_CODEX_RESPONSES_API, \"openai-completions\"]);";

const APPLY_NEEDLE = "    if (model?.api !== OPENAI_CODEX_RESPONSES_API) {\n        const message = \"Fast mode is only available for OpenAI Codex models.\";";
const APPLY_REPLACEMENT = "    if (!supportsFastMode(model)) {\n        const message = \"Fast mode is only available for OpenAI Codex, xAI, and Claude Opus 5 / 4.8 models.\";";

const BOOT_GATE_NEEDLE = "        if (model?.api !== OPENAI_CODEX_RESPONSES_API) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n            return;\n        }";
const BOOT_GATE_REPLACEMENT = "        if (!supportsFastMode(model)) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n            return;\n        }";

const REQUEST_HEAD_NEEDLE = "    pi.on(\"before_provider_request\", (event, ctx) => {\n        let effectiveServiceTier;";
const REQUEST_HEAD_REPLACEMENT = "    pi.on(\"before_provider_request\", (event, ctx) => {\n        // Anthropic fast mode never emits `service_tier`, so it returns before the tier ladder and\n        // stamps `speed`/`betas` instead. `sessionFastMode` is the single source of truth here: it\n        // already absorbed the remembered preference at session_start and every model switch.\n        if (isAnthropicFastModel(ctx.model)) {\n            return applyAnthropicFastMode(event.payload, sessionFastMode);\n        }\n        let effectiveServiceTier;";

const REQUEST_NEEDLE = "        if (ctx.model?.api === OPENAI_CODEX_RESPONSES_API) {";
const REQUEST_REPLACEMENT = "        if (ctx.model?.api === OPENAI_CODEX_RESPONSES_API || ctx.model?.provider === \"xai\") {";

const DESC_NEEDLE = "        description: \"Turn OpenAI Codex fast mode on or off for the current model\",";
const DESC_REPLACEMENT = "        description: \"Turn fast mode on or off: Codex Fast, xAI priority, Claude Opus speed\",";

export function isServiceTierUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/service-tier.js");
}

/**
 * Baseline: persist -fast catalog identity across restart. xAI /fast is opt-in priority.
 * Anthropic /fast is `speed: "fast"` + fast-mode beta on Opus 5 / 4.8.
 */
export function injectServiceTier(source) {
  let next = replaceOnce(source, HELPERS_NEEDLE, HELPERS_REPLACEMENT, "service-tier anthropic helpers");
  next = replaceOnce(next, BOOT_NEEDLE, BOOT_REPLACEMENT, "service-tier boot persist");
  next = replaceOnce(next, SELECT_NEEDLE, SELECT_REPLACEMENT, "service-tier model_select persist");
  next = replaceOnce(next, APIS_NEEDLE, APIS_REPLACEMENT, "service-tier xai completions");
  next = replaceOnce(next, APPLY_NEEDLE, APPLY_REPLACEMENT, "service-tier fast apply gate");
  next = replaceOnce(next, BOOT_GATE_NEEDLE, BOOT_GATE_REPLACEMENT, "service-tier fast boot gate");
  next = replaceOnce(next, REQUEST_HEAD_NEEDLE, REQUEST_HEAD_REPLACEMENT, "service-tier anthropic request");
  next = replaceOnce(next, REQUEST_NEEDLE, REQUEST_REPLACEMENT, "service-tier xai request");
  return replaceOnce(next, DESC_NEEDLE, DESC_REPLACEMENT, "service-tier fast description");
}
