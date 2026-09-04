import { replaceOnce } from "./core-replace.mjs";

const BOOT_NEEDLE = "        // The flag is derived from the POST-swap model: a `-fast` catalog variant swaps down to\n        // its base before this reads `ctx.serviceTier`, so inheritance is judged on the model the\n        // user actually ends up on.\n        const remembered = getRememberedServiceTier(settingsManager, ctx.modelRegistry, model);\n        const baseModel = findBaseModel(ctx.modelRegistry, model);\n        if (baseModel) {\n            await pi.setSessionModel(baseModel);\n        }\n        sessionFastMode = remembered === PRIORITY_TIER || (remembered === undefined && ctx.serviceTier === PRIORITY_TIER);\n        pi.setSessionFastMode(sessionFastMode);";

const BOOT_REPLACEMENT = "        // A remembered priority means the selected `-fast` catalog identity is itself the user's\n        // persisted default. Preserve that exact identity across startup; only normalize to the\n        // base model when an explicit remembered non-priority tier turns fast mode off.\n        const remembered = getRememberedServiceTier(settingsManager, ctx.modelRegistry, model);\n        const baseModel = findBaseModel(ctx.modelRegistry, model);\n        sessionFastMode = remembered === PRIORITY_TIER || (remembered === undefined && ctx.serviceTier === PRIORITY_TIER);\n        if (baseModel && !sessionFastMode) {\n            await pi.setSessionModel(baseModel);\n        }\n        pi.setSessionFastMode(sessionFastMode);";

const SELECT_NEEDLE = "    pi.on(\"model_select\", (event, ctx) => {\n        // A model switch changes the base key the memory lives under, so the live tier is RE-DERIVED\n        // for the incoming model instead of merely dropped: dropping it would leave a remembered\n        // \"auto\" unable to suppress a catalog-inherited priority after switching away and back in one\n        // session, silently re-sending the tier `/fast off` turned off. Per-key scoping is preserved —\n        // each model reads ITS OWN memory, never the previous model's.\n        const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });\n        const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, event.model);\n        liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;\n        liveMemoryTier = getRememberedServiceTier(settingsManager, ctx.modelRegistry, event.model);\n        // `service_tier` is an OpenAI-family request field, so hopping to a non-Codex model leaves the\n        // intent with nothing to act on: `before_provider_request` already refuses to emit the tier\n        // there, but the session flag kept `isFastModeActive()` (and with it the RPC `fastMode` and the\n        // lightning indicator) claiming fast for a model that can never be served at that tier.\n        //\n        // Codex -> Codex is deliberately untouched: fast mode is a SESSION intent that survives a\n        // mid-session Codex switch (see service-tier-extension.test.ts \"keeps session fast mode on\n        // across a mid-session switch to another Codex model\"), and an incoming model's remembered\n        // \"auto\" is honored on the wire by `liveMemoryTier` below, not by clearing the flag here.\n        if (sessionFastMode && event.model.api !== OPENAI_CODEX_RESPONSES_API) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n        }\n    });\n";

const SELECT_REPLACEMENT = "    pi.on(\"model_select\", async (event, ctx) => {\n        // A model switch changes the base key the memory lives under, so the live tier is RE-DERIVED\n        // for the incoming model instead of merely dropped: dropping it would leave a remembered\n        // \"auto\" unable to suppress a catalog-inherited priority after switching away and back in one\n        // session, silently re-sending the tier `/fast off` turned off. Per-key scoping is preserved —\n        // each model reads ITS OWN memory, never the previous model's.\n        const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });\n        const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, event.model);\n        liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;\n        liveMemoryTier = getRememberedServiceTier(settingsManager, ctx.modelRegistry, event.model);\n        // Choosing a catalog `-fast` model is an explicit fast-mode choice, even when an older\n        // `/fast off` memory exists for its base model. Persist the choice on the shared base key\n        // so a fresh session restores the exact fast identity instead of immediately swapping down.\n        if ((event.source === \"set\" || event.source === \"cycle\") && findBaseModel(ctx.modelRegistry, event.model)) {\n            settingsManager.setModelServiceTier(memoryModel.provider, memoryModel.id, PRIORITY_TIER);\n            await settingsManager.flush();\n            liveMemoryTier = PRIORITY_TIER;\n            sessionFastMode = true;\n            pi.setSessionFastMode(true);\n        }\n    });\n";

const APIS_NEEDLE = "const SERVICE_TIER_APIS = new Set([\"openai-responses\", OPENAI_CODEX_RESPONSES_API]);";
const APIS_REPLACEMENT = "const SERVICE_TIER_APIS = new Set([\"openai-responses\", OPENAI_CODEX_RESPONSES_API, \"openai-completions\"]);";

const APPLY_NEEDLE = "    if (model?.api !== OPENAI_CODEX_RESPONSES_API) {\n        const message = \"Fast mode is only available for OpenAI Codex models.\";";
const APPLY_REPLACEMENT = "    if (model?.api !== OPENAI_CODEX_RESPONSES_API && model?.provider !== \"xai\") {\n        const message = \"Fast mode is only available for OpenAI Codex and xAI models.\";";

const BOOT_GATE_NEEDLE = "        if (model?.api !== OPENAI_CODEX_RESPONSES_API) {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n            return;\n        }";
const BOOT_GATE_REPLACEMENT = "        if (model?.api !== OPENAI_CODEX_RESPONSES_API && model?.provider !== \"xai\") {\n            sessionFastMode = false;\n            pi.setSessionFastMode(false);\n            return;\n        }";

const REQUEST_NEEDLE = "        if (ctx.model?.api === OPENAI_CODEX_RESPONSES_API) {";
const REQUEST_REPLACEMENT = "        if (ctx.model?.api === OPENAI_CODEX_RESPONSES_API || ctx.model?.provider === \"xai\") {";

const DESC_NEEDLE = "        description: \"Turn OpenAI Codex fast mode on or off for the current model\",";
const DESC_REPLACEMENT = "        description: \"Turn Codex Fast or xAI priority on or off for the current model\",";

export function isServiceTierUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/service-tier.js");
}

/** Baseline: persist -fast catalog identity across restart. xAI /fast is opt-in priority. */
export function injectServiceTier(source) {
  let next = replaceOnce(source, BOOT_NEEDLE, BOOT_REPLACEMENT, "service-tier boot persist");
  next = replaceOnce(next, SELECT_NEEDLE, SELECT_REPLACEMENT, "service-tier model_select persist");
  next = replaceOnce(next, APIS_NEEDLE, APIS_REPLACEMENT, "service-tier xai completions");
  next = replaceOnce(next, APPLY_NEEDLE, APPLY_REPLACEMENT, "service-tier xai apply");
  next = replaceOnce(next, BOOT_GATE_NEEDLE, BOOT_GATE_REPLACEMENT, "service-tier xai boot gate");
  next = replaceOnce(next, REQUEST_NEEDLE, REQUEST_REPLACEMENT, "service-tier xai request");
  return replaceOnce(next, DESC_NEEDLE, DESC_REPLACEMENT, "service-tier xai description");
}
