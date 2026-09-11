// Derived from @code-yeongyu/senpi 2026.9.4-3's service-tier extension and
// Rubato's core-service-tier transform. See THIRD_PARTY_NOTICES.md.
import { SettingsManager as StockSettingsManager } from "@earendil-works/pi-coding-agent";

export const PRIORITY_TIER = "priority";
export const AUTO_TIER = "auto";
export const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

const FAST_MODEL_SUFFIX = "-fast";
const FAST_ARGUMENTS = Object.freeze(["on", "off"]);
const FAST_USAGE = "Usage: /fast [on|off]";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const SERVICE_TIER_APIS = new Set([
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
]);
const ANTHROPIC_FAST_MODEL_ID = /^claude-opus-(?:5|4-8)(?:-\d{8})?$/;

const EMPTY_STATE = Object.freeze({
  revision: 0,
  active: false,
  supported: false,
  provider: undefined,
  modelId: undefined,
  wireMode: undefined,
  rememberedTier: undefined,
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelServiceTier(modelRegistry, model) {
  if (typeof modelRegistry?.getServiceTier === "function") {
    return modelRegistry.getServiceTier(model);
  }
  return model?.serviceTier;
}

function requestModelId(modelRegistry, model) {
  if (typeof modelRegistry?.getUpstreamModelId === "function") {
    return modelRegistry.getUpstreamModelId(model) ?? model.id;
  }
  return model?.upstreamModelId ?? model?.id;
}

function isCompatibleFastVariant(modelRegistry, baseModel, fastModel) {
  return (
    fastModel.provider === baseModel.provider &&
    fastModel.api === baseModel.api &&
    modelServiceTier(modelRegistry, fastModel) === PRIORITY_TIER &&
    requestModelId(modelRegistry, fastModel) === requestModelId(modelRegistry, baseModel)
  );
}

export function findBaseModel(modelRegistry, fastModel) {
  if (!fastModel?.id?.endsWith(FAST_MODEL_SUFFIX)) return undefined;
  const baseModelId = fastModel.id.slice(0, -FAST_MODEL_SUFFIX.length);
  const baseModel = modelRegistry.find(fastModel.provider, baseModelId);
  return baseModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel)
    ? baseModel
    : undefined;
}

export function findFastModel(modelRegistry, baseModel) {
  if (!baseModel || baseModel.id.endsWith(FAST_MODEL_SUFFIX)) return undefined;
  const fastModel = modelRegistry.find(baseModel.provider, `${baseModel.id}${FAST_MODEL_SUFFIX}`);
  return fastModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel)
    ? fastModel
    : undefined;
}

export function resolveServiceTierMemoryModel(modelRegistry, model) {
  return findBaseModel(modelRegistry, model) ?? model;
}

export function isAnthropicFastModel(model, modelRegistry) {
  if (model?.api !== "anthropic-messages") return false;
  if (
    model.provider !== "anthropic" &&
    !/api\.anthropic\.com/.test(String(model.baseUrl ?? ""))
  ) {
    return false;
  }
  return ANTHROPIC_FAST_MODEL_ID.test(
    String(requestModelId(modelRegistry, model) ?? "").toLowerCase(),
  );
}

export function fastWireMode(model, modelRegistry) {
  if (model?.api === OPENAI_CODEX_RESPONSES_API) return "service-tier";
  if (model?.provider === "xai" && SERVICE_TIER_APIS.has(model.api)) return "service-tier";
  if (isAnthropicFastModel(model, modelRegistry)) return "anthropic-fast";
  return undefined;
}

export function supportsFastMode(model, modelRegistry) {
  return fastWireMode(model, modelRegistry) !== undefined;
}

export function addServiceTierToPayload(payload, serviceTier) {
  if (!serviceTier || !isRecord(payload) || payload.service_tier !== undefined) return payload;
  return { ...payload, service_tier: serviceTier };
}

export function applyAnthropicFastMode(payload, enabled) {
  if (!enabled || !isRecord(payload) || payload.speed !== undefined) return payload;
  const betas = Array.isArray(payload.betas) ? payload.betas : [];
  return {
    ...payload,
    speed: "fast",
    betas: betas.includes(ANTHROPIC_FAST_BETA)
      ? betas
      : [...betas, ANTHROPIC_FAST_BETA],
  };
}

function toCompletions(values, prefix) {
  const matches = values.filter((value) => value.startsWith(prefix.trim()));
  return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function requireSettingsContract(settingsManager) {
  for (const method of ["getModelServiceTier", "setModelServiceTier", "flush"]) {
    if (typeof settingsManager?.[method] !== "function") {
      throw new Error(
        `service-tier: stock SettingsManager is missing ${method}; apply the version-locked service-tier patch`,
      );
    }
  }
  return settingsManager;
}

function stateFor(model, modelRegistry, active, rememberedTier) {
  return {
    active,
    supported: supportsFastMode(model, modelRegistry),
    provider: model?.provider,
    modelId: model?.id,
    wireMode: fastWireMode(model, modelRegistry),
    rememberedTier,
  };
}

/**
 * Build one service-tier extension and its read-only host bridge.
 *
 * Stock 0.85.1 does not expose `setSessionFastMode`; getState/onChange is the
 * explicit boundary for a later footer/RPC adapter. `agentDir` must be supplied
 * by SDK embedders that do not use Pi's normal PI_CODING_AGENT_DIR resolution.
 */
export function createServiceTierFeature({
  SettingsManager = StockSettingsManager,
  agentDir,
  settingsManagerFactory,
} = {}) {
  const listeners = new Set();
  let publicState = EMPTY_STATE;

  const publish = (next) => {
    const changed = Object.entries(next).some(([key, value]) => publicState[key] !== value);
    if (!changed) return publicState;
    publicState = Object.freeze({ ...next, revision: publicState.revision + 1 });
    for (const listener of listeners) {
      try {
        listener(publicState);
      } catch {
        // Host observation must not break model selection or request wiring.
      }
    }
    return publicState;
  };

  const openSettings = (ctx) => requireSettingsContract(
    settingsManagerFactory
      ? settingsManagerFactory(ctx)
      : SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() }),
  );

  const extension = (pi) => {
    let sessionFastMode = false;
    publicState = EMPTY_STATE;

    const readRememberedTier = (ctx, model = ctx.model) => {
      if (!model) return undefined;
      const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, model);
      return openSettings(ctx).getModelServiceTier(memoryModel.provider, memoryModel.id);
    };

    const updateForModel = (ctx, model, rememberedTier) => {
      const supported = supportsFastMode(model, ctx.modelRegistry);
      sessionFastMode = supported && (
        rememberedTier === PRIORITY_TIER ||
        (rememberedTier === undefined && modelServiceTier(ctx.modelRegistry, model) === PRIORITY_TIER)
      );
      publish(stateFor(model, ctx.modelRegistry, sessionFastMode, rememberedTier));
    };

    pi.on("session_start", async (_event, ctx) => {
      const model = ctx.model;
      if (!model || !supportsFastMode(model, ctx.modelRegistry)) {
        sessionFastMode = false;
        publish(stateFor(model, ctx.modelRegistry, false, undefined));
        return;
      }

      const rememberedTier = readRememberedTier(ctx, model);
      const baseModel = findBaseModel(ctx.modelRegistry, model);
      const active = rememberedTier === PRIORITY_TIER || (
        rememberedTier === undefined && modelServiceTier(ctx.modelRegistry, model) === PRIORITY_TIER
      );
      if (baseModel && !active) await pi.setModel(baseModel);
      updateForModel(ctx, ctx.model ?? baseModel ?? model, rememberedTier);
    });

    pi.on("model_select", async (event, ctx) => {
      const model = event.model;
      if (!supportsFastMode(model, ctx.modelRegistry)) {
        sessionFastMode = false;
        publish(stateFor(model, ctx.modelRegistry, false, undefined));
        return;
      }

      const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, model);
      const settingsManager = openSettings(ctx);
      let rememberedTier = settingsManager.getModelServiceTier(memoryModel.provider, memoryModel.id);
      if (
        (event.source === "set" || event.source === "cycle") &&
        findBaseModel(ctx.modelRegistry, model)
      ) {
        settingsManager.setModelServiceTier(memoryModel.provider, memoryModel.id, PRIORITY_TIER);
        await settingsManager.flush();
        rememberedTier = PRIORITY_TIER;
      }

      // `/fast on` is a live session intent in Senpi/Rubato. Keep it while the
      // user moves between fast-capable models (notably Codex -> Codex), while
      // leaving persistence scoped to each model for reload/restart. A switch
      // to an unsupported model above still disables the live intent.
      if (sessionFastMode) {
        publish(stateFor(model, ctx.modelRegistry, true, rememberedTier));
      } else {
        updateForModel(ctx, model, rememberedTier);
      }
    });

    pi.registerCommand("fast", {
      description: "Turn fast mode on or off: Codex Fast, xAI priority, Claude Opus speed",
      argumentHint: "[on|off]",
      getArgumentCompletions: (prefix) => toCompletions(FAST_ARGUMENTS, prefix),
      handler: async (args, ctx) => {
        const argument = args.trim().toLowerCase();
        if (argument !== "" && !FAST_ARGUMENTS.includes(argument)) {
          ctx.ui.notify(FAST_USAGE, "error");
          return;
        }

        const model = ctx.model;
        if (!model || !supportsFastMode(model, ctx.modelRegistry)) {
          const message = "Fast mode is only available for OpenAI Codex, xAI, and Claude Opus 5 / 4.8 models.";
          sessionFastMode = false;
          publish(stateFor(model, ctx.modelRegistry, false, undefined));
          ctx.ui.notify(message, "warning");
          return;
        }

        const enabled = argument === "" ? !sessionFastMode : argument === "on";
        const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, model);
        const settingsManager = openSettings(ctx);
        const tier = enabled ? PRIORITY_TIER : AUTO_TIER;
        settingsManager.setModelServiceTier(memoryModel.provider, memoryModel.id, tier);
        await settingsManager.flush();

        const targetModel = enabled
          ? findFastModel(ctx.modelRegistry, model)
          : findBaseModel(ctx.modelRegistry, model);
        if (targetModel) await pi.setModel(targetModel);

        sessionFastMode = enabled;
        publish(stateFor(ctx.model ?? targetModel ?? model, ctx.modelRegistry, enabled, tier));
        ctx.ui.notify(
          `Fast mode ${enabled ? "enabled" : "disabled"}: ${(ctx.model ?? targetModel ?? model).id}`,
          "info",
        );
      },
    });

    pi.on("before_provider_request", (event, ctx) => {
      const wireMode = fastWireMode(ctx.model, ctx.modelRegistry);
      if (wireMode === "anthropic-fast") {
        return applyAnthropicFastMode(event.payload, sessionFastMode);
      }
      if (wireMode === "service-tier") {
        return addServiceTierToPayload(event.payload, sessionFastMode ? PRIORITY_TIER : undefined);
      }
      return event.payload;
    });
  };

  return Object.freeze({
    extension,
    getState: () => publicState,
    onChange(listener) {
      if (typeof listener !== "function") throw new TypeError("service-tier listener must be a function");
      listeners.add(listener);
      listener(publicState);
      return () => listeners.delete(listener);
    },
  });
}

export const serviceTierFeature = createServiceTierFeature();
export default serviceTierFeature.extension;
