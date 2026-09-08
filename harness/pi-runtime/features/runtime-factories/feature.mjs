import { patches } from "./patches.mjs";

export const runtimeFactoriesFeature = Object.freeze({
  id: "runtime-factories",
  patches: Object.freeze(patches),
  files: Object.freeze([]),
});

export const feature = runtimeFactoriesFeature;

export default runtimeFactoriesFeature;
