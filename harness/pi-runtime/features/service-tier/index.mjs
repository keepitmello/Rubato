export {
  ANTHROPIC_FAST_BETA,
  AUTO_TIER,
  PRIORITY_TIER,
  ULTRAFAST_MODEL_IDS,
  ULTRAFAST_TIER,
  addServiceTierToPayload,
  applyAnthropicFastMode,
  createServiceTierFeature,
  fastWireMode,
  findBaseModel,
  findFastModel,
  isAnthropicFastModel,
  resolveServiceTierMemoryModel,
  serviceTierFeature,
  supportsFastMode,
  supportsUltrafastMode,
} from "./extension.mjs";
export { files, patches, serviceTierRuntimeFeature } from "./patches.mjs";
export { default } from "./extension.mjs";
