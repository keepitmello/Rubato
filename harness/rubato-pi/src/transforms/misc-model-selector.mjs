import { replaceOnce } from "./misc-replace.mjs";

const IMPORT_NEEDLE = "import { getModelFullId, isFavoriteModel, toggleFavoriteModel } from \"./model-favorites.js\";\n/**\n * Component that renders a model selector with search\n */";

const IMPORT_REPLACEMENT = "import { getModelFullId, isFavoriteModel, toggleFavoriteModel } from \"./model-favorites.js\";\nconst PROVIDER_ORDER = [\"openai-codex\", \"anthropic\", \"xai\", \"google-antigravity\", \"kiro\", \"cursor\", \"opencode\"];\nconst MODEL_ORDER = {\n    \"openai-codex\": [\"gpt-5.6-sol\", \"gpt-5.6-terra\", \"gpt-5.6-luna\", \"gpt-5.6-sol-fast\", \"gpt-5.6-terra-fast\", \"gpt-5.6-luna-fast\", \"gpt-6-astra\", \"gpt-6-astra-fast\", \"gpt-daybreak-blue-latest\", \"gpt-daybreak-blue-latest-fast\"],\n    anthropic: [\"claude-fable-5-1\", \"claude-opus-5\", \"claude-sonnet-5\", \"claude-haiku-4-5\"],\n    xai: [\"grok-4.6\"],\n    \"google-antigravity\": [\"gemini-3.8-flash\"],\n    kiro: [\"gpt-5.6-sol\", \"claude-opus-5\"],\n    cursor: [\"gpt-5.6-sol\", \"claude-fable-5-1\", \"claude-opus-5\", \"cursor-grok-4.6\", \"gemini-3.8-flash\", \"kimi-k3\", \"composer-2.5\"],\n    opencode: [\"muse-spark-1.3-contributor-free\"],\n};\nfunction rankedIndex(values, value) {\n    const index = values.indexOf(value);\n    return index < 0 ? Number.MAX_SAFE_INTEGER : index;\n}\nexport function sortModelItems(models) {\n    return [...models].sort((a, b) => {\n        const providerRank = rankedIndex(PROVIDER_ORDER, a.provider) - rankedIndex(PROVIDER_ORDER, b.provider);\n        if (providerRank !== 0)\n            return providerRank;\n        const providerCompare = a.provider.localeCompare(b.provider);\n        if (providerCompare !== 0)\n            return providerCompare;\n        const order = MODEL_ORDER[a.provider] ?? [];\n        const modelRank = rankedIndex(order, a.id) - rankedIndex(order, b.id);\n        return modelRank !== 0 ? modelRank : a.id.localeCompare(b.id);\n    });\n}\nfunction modelPickerLabel(item) {\n    if (item.provider === \"openai-codex\" && item.id.startsWith(\"gpt-daybreak-blue-\")) {\n        return item.model.name;\n    }\n    // Cursor Grok wire id is `cursor-grok-4.6`. Show the xAI name plus Fast.\n    if (item.provider === \"cursor\" && item.id === \"cursor-grok-4.6\") {\n        return \"grok-4.6-fast\";\n    }\n    if (item.id === \"claude-fable-5-1\") {\n        return \"Fable 5.1\";\n    }\n    return item.id;\n}\n/**\n * Component that renders a model selector with search\n */";

const SORT_NEEDLE = "    sortModels(models) {\n        const sorted = [...models];\n        // Sort: current model first, then favorites, then by provider/model.\n        sorted.sort((a, b) => {\n            const aIsCurrent = modelsAreEqual(this.currentModel, a.model);\n            const bIsCurrent = modelsAreEqual(this.currentModel, b.model);\n            if (aIsCurrent && !bIsCurrent)\n                return -1;\n            if (!aIsCurrent && bIsCurrent)\n                return 1;\n            const aIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, a.fullId);\n            const bIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, b.fullId);\n            if (aIsFavorite && !bIsFavorite)\n                return -1;\n            if (!aIsFavorite && bIsFavorite)\n                return 1;\n            const providerCompare = a.provider.localeCompare(b.provider);\n            if (providerCompare !== 0)\n                return providerCompare;\n            return a.id.localeCompare(b.id);\n        });\n        return sorted;\n    }";

const SORT_REPLACEMENT = "    sortModels(models) {\n        return sortModelItems(models);\n    }";

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
