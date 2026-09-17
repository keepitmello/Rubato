import { PRODUCT_MODEL_ORDER, PRODUCT_PROVIDER_ORDER } from "../../../../packages/model-core/src/product-model-catalog.mjs";
import { replaceOnce } from "./misc-replace.mjs";

const IMPORT_NEEDLE = "import { getModelFullId, isFavoriteModel, toggleFavoriteModel } from \"./model-favorites.js\";\n/**\n * Component that renders a model selector with search\n */";

const IMPORT_REPLACEMENT = "import { getModelFullId, isFavoriteModel, toggleFavoriteModel } from \"./model-favorites.js\";\nconst PROVIDER_ORDER = " + JSON.stringify([...PRODUCT_PROVIDER_ORDER]) + ";\nconst MODEL_ORDER = " + JSON.stringify(PRODUCT_MODEL_ORDER) + ";\nfunction rankedIndex(values, value) {\n    const index = values.indexOf(value);\n    return index < 0 ? Number.MAX_SAFE_INTEGER : index;\n}\nexport function sortModelItems(models) {\n    return [...models].sort((a, b) => {\n        const providerRank = rankedIndex(PROVIDER_ORDER, a.provider) - rankedIndex(PROVIDER_ORDER, b.provider);\n        if (providerRank !== 0)\n            return providerRank;\n        const providerCompare = a.provider.localeCompare(b.provider);\n        if (providerCompare !== 0)\n            return providerCompare;\n        const order = MODEL_ORDER[a.provider] ?? [];\n        const modelRank = rankedIndex(order, a.id) - rankedIndex(order, b.id);\n        return modelRank !== 0 ? modelRank : a.id.localeCompare(b.id);\n    });\n}\nfunction modelPickerLabel(item) {\n    if (item.provider === \"openai-codex\" && item.id.startsWith(\"gpt-daybreak-blue-\")) {\n        return item.model.name;\n    }\n    if (item.provider === \"cursor\" && item.id === \"cursor-grok-4.6\") {\n        return \"grok-4.6-fast\";\n    }\n    if (item.id === \"claude-fable-5-1\") {\n        return \"Fable 5.1\";\n    }\n    return item.id;\n}\n/**\n * Component that renders a model selector with search\n */";

const SORT_NEEDLE = "    sortModels(models) {\n        const sorted = [...models];\n        // Sort: current model first, then favorites, then by provider/model.\n        sorted.sort((a, b) => {\n            const aIsCurrent = modelsAreEqual(this.currentModel, a.model);\n            const bIsCurrent = modelsAreEqual(this.currentModel, b.model);\n            if (aIsCurrent && !bIsCurrent)\n                return -1;\n            if (!aIsCurrent && bIsCurrent)\n                return 1;\n            const aIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, a.fullId);\n            const bIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, b.fullId);\n            if (aIsFavorite && !bIsFavorite)\n                return -1;\n            if (!aIsFavorite && bIsFavorite)\n                return 1;\n            const providerCompare = a.provider.localeCompare(b.provider);\n            if (providerCompare !== 0)\n                return providerCompare;\n            return a.id.localeCompare(b.id);\n        });\n        return sorted;\n    }";

// B7: 피커에 드는 건 지원 7사만. models.json disabledProviders(39개)와
// PROVIDER_ORDER는 오늘 겹치지 않아서(교집합 없음) 결과는 같고, 모르는
// 신원(provider)은 기본 숨김이 안전하다. 현재 모델은 예외로 두되 openai API
// 는 예외에서 뺀다 — 과금 경로라 현재값이어도 고르면 안 된다.
const SORT_REPLACEMENT = "    sortModels(models) {\n        return sortModelItems(models.filter((item) => item.provider !== \"openai\" && ((MODEL_ORDER[item.provider] ?? []).includes(item.id) || modelsAreEqual(this.currentModel, item.model))));\n    }";

const LABEL_NEEDLE = "            const isCurrent = modelsAreEqual(this.currentModel, item.model);\n            const favoriteMarker = isFavoriteModel(this.favoriteIds, item.fullId)\n                ? theme.fg(\"success\", \"* \")\n                : theme.fg(\"dim\", \"  \");\n            let line = \"\";\n            if (isSelected) {\n                const prefix = theme.fg(\"accent\", \"→ \");\n                const modelText = `${favoriteMarker}${theme.fg(\"accent\", item.id)}`;\n                const providerBadge = theme.fg(\"muted\", `[${item.provider}]`);\n                const checkmark = isCurrent ? theme.fg(\"success\", \" ✓\") : \"\";\n                line = `${prefix}${modelText} ${providerBadge}${checkmark}`;\n            }\n            else {\n                const modelText = `  ${favoriteMarker}${item.id}`;\n                const providerBadge = theme.fg(\"muted\", `[${item.provider}]`);\n                const checkmark = isCurrent ? theme.fg(\"success\", \" ✓\") : \"\";\n                line = `${modelText} ${providerBadge}${checkmark}`;\n            }";

const LABEL_REPLACEMENT = "            const isCurrent = modelsAreEqual(this.currentModel, item.model);\n            const label = modelPickerLabel(item);\n            const favoriteMarker = isFavoriteModel(this.favoriteIds, item.fullId)\n                ? theme.fg(\"success\", \"* \")\n                : theme.fg(\"dim\", \"  \");\n            let line = \"\";\n            if (isSelected) {\n                const prefix = theme.fg(\"accent\", \"→ \");\n                const modelText = `${favoriteMarker}${theme.fg(\"accent\", label)}`;\n                const providerBadge = theme.fg(\"muted\", `[${item.provider}]`);\n                const checkmark = isCurrent ? theme.fg(\"success\", \" ✓\") : \"\";\n                line = `${prefix}${modelText} ${providerBadge}${checkmark}`;\n            }\n            else {\n                const modelText = `  ${favoriteMarker}${label}`;\n                const providerBadge = theme.fg(\"muted\", `[${item.provider}]`);\n                const checkmark = isCurrent ? theme.fg(\"success\", \" ✓\") : \"\";\n                line = `${modelText} ${providerBadge}${checkmark}`;\n            }";

export function isModelSelectorUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/model-selector.js");
}

/**
 * Series #4 + #7 + #26 stacked onto pristine model-selector.js.
 * #5 (.d.ts) is skipped — types never load at runtime.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectModelSelector(source) {
  let next = replaceOnce(source, IMPORT_NEEDLE, IMPORT_REPLACEMENT, "model-selector helpers");
  next = replaceOnce(next, SORT_NEEDLE, SORT_REPLACEMENT, "sortModels");
  next = replaceOnce(next, LABEL_NEEDLE, LABEL_REPLACEMENT, "picker labels");
  return replaceOnce(
    next,
    "//# sourceMappingURL=model-selector.js.map",
    "//# sourceMappingURL=model-selector.js.map\n",
    "model-selector eof newline",
  );
}
