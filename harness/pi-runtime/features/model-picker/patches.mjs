import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const CATALOG_IMPORT = 'import { modelPickerLabel, sortModelItems } from "../../../rubato-features/model-picker/catalog.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[model-picker:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[model-picker:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[model-picker:" + label + "] expected pristine feature seam");
}

const IMPORT_BEFORE = 'import { keyDisplayText, keyHint } from "./keybinding-hints.js";\n/**\n * Component that renders a model selector with search\n */';
const IMPORT_AFTER = 'import { keyDisplayText, keyHint } from "./keybinding-hints.js";\n' + CATALOG_IMPORT + '\n/**\n * Component that renders a model selector with search\n */';

const SORT_BEFORE = `    sortModels(models) {\n        const sorted = [...models];\n        // Sort: current model first, default model second, then by provider.\n        sorted.sort((a, b) => {\n            const aIsCurrent = modelsAreEqual(this.currentModel, a.model);\n            const bIsCurrent = modelsAreEqual(this.currentModel, b.model);\n            if (aIsCurrent && !bIsCurrent)\n                return -1;\n            if (!aIsCurrent && bIsCurrent)\n                return 1;\n            const aIsDefault = this.isDefaultModel(a.model);\n            const bIsDefault = this.isDefaultModel(b.model);\n            if (aIsDefault && !bIsDefault)\n                return -1;\n            if (!aIsDefault && bIsDefault)\n                return 1;\n            return a.provider.localeCompare(b.provider);\n        });\n        return sorted;\n    }`;
const SORT_AFTER = `    sortModels(models) {\n        return sortModelItems(models);\n    }`;

const LABEL_BEFORE = '            const modelText = isSelected ? theme.fg("accent", item.id) : item.id;';
const LABEL_AFTER = '            const label = modelPickerLabel(item);\n            const modelText = isSelected ? theme.fg("accent", label) : label;';

export function patchModelSelector(source) {
  unpatched(source, CATALOG_IMPORT, "catalog-import");
  let next = replaceOnce(source, IMPORT_BEFORE, IMPORT_AFTER, "catalog-import");
  next = replaceOnce(next, SORT_BEFORE, SORT_AFTER, "sortModels");
  return replaceOnce(next, LABEL_BEFORE, LABEL_AFTER, "picker-label");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/model-picker/catalog.mjs",
    sourcePath: fileURLToPath(new URL("./catalog.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "model-picker:selector",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/modes/interactive/components/model-selector.js",
    preimageSha256: "b1ab2e6efd1511f70f32a1c1530f01c782aa0e661ab9ead6e38a1c3735b667eb",
    apply: patchModelSelector,
  }),
]);

export const feature = Object.freeze({ id: "model-picker", patches, files });
export default feature;
