import { normalizeCursorCatalog } from "./catalog-grouping.js";
import { getCursorVariantAlias } from "./model-capabilities.js";
function isGroupedShape(model) {
    return model.compat?.cursorReasoning !== undefined || getCursorVariantAlias(model.id) === undefined;
}
function entryToModel(entry, maxTokensById) {
    const representative = entry.representativeVariantId ?? entry.legacyAliases[0] ?? entry.id;
    const maxTokens = maxTokensById.get(representative) ?? maxTokensById.get(entry.id) ?? 64000;
    return {
        id: entry.id,
        name: entry.name,
        api: "cursor-agent",
        provider: "cursor",
        baseUrl: "https://api2.cursor.sh",
        reasoning: entry.reasoning,
        ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
        input: entry.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.window,
        maxTokens,
        ...(entry.representativeVariantId !== undefined && entry.representativeVariantId !== entry.id
            ? { upstreamModelId: entry.representativeVariantId }
            : {}),
        compat: {
            ...(entry.cursorMaxMode ? { cursorMaxMode: true } : {}),
            ...(entry.capabilityId !== undefined && entry.representativeVariantId !== undefined
                ? {
                    cursorReasoning: {
                        capabilityId: entry.capabilityId,
                        ...(entry.thinkingMode !== undefined ? { thinkingMode: entry.thinkingMode } : {}),
                        representativeVariantId: entry.representativeVariantId,
                    },
                }
                : {}),
        },
    };
}
/**
 * Idempotent stored-catalog transform: pre-grouping 204-variant cursor entries
 * are regrouped into selectable identities; already-grouped, unknown, and
 * malformed entries pass through unchanged in stable input order.
 */
export function regroupStoredCursorModels(models) {
    const legacy = models.filter((model) => !isGroupedShape(model));
    if (legacy.length === 0)
        return [...models];
    const maxTokensById = new Map(models.map((model) => [model.id, model.maxTokens]));
    const regrouped = new Map(normalizeCursorCatalog(legacy.map((model) => ({
        id: model.id,
        name: model.name,
        input: model.input.filter((modality) => modality !== "video"),
        cursorMaxMode: model.compat?.cursorMaxMode === true,
    }))).map((entry) => [entry.id, entryToModel(entry, maxTokensById)]));
    const seen = new Set();
    const out = [];
    for (const model of models) {
        if (isGroupedShape(model)) {
            out.push(model);
            continue;
        }
        const alias = getCursorVariantAlias(model.id);
        const targetId = alias?.targetId ?? model.id;
        if (seen.has(targetId))
            continue;
        seen.add(targetId);
        const transformed = regrouped.get(targetId);
        if (transformed !== undefined) {
            out.push(transformed);
        }
        else {
            out.push(model);
        }
    }
    return out;
}
//# sourceMappingURL=store-migration.js.map