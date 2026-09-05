import { replaceOnce } from "./core-replace.mjs";

export const CONTEXT_PIPELINE_NEEDLE =
  "export function buildCompactionContext(input) {\n" +
  "    if (input.laneOwnsCompaction) {\n" +
  "        return repairOrphanedToolResults(convertToLlm(input.event.messages));\n" +
  "    }\n" +
  "    const admittedMessages = admitContextToolResults(input.event.messages, input.contextWindow, input.toolAdmissionEnabled);\n";

export const STRIP_CURSOR_THINKING_HELPER =
  "function stripCursorThinking(messages) {\n" +
  "    return messages.map((m) => {\n" +
  "        if (m.role !== \"assistant\" || !Array.isArray(m.content))\n" +
  "            return m;\n" +
  "        if (!m.content.some((b) => b.type === \"thinking\"))\n" +
  "            return m;\n" +
  "        return {\n" +
  "            ...m,\n" +
  "            content: m.content.filter((b) => b.type !== \"thinking\"),\n" +
  "        };\n" +
  "    });\n" +
  "}\n";

export const CONTEXT_PIPELINE_REPLACEMENT =
  STRIP_CURSOR_THINKING_HELPER +
  "export function buildCompactionContext(input) {\n" +
  "    const isCursor = input.ctx?.model?.provider === \"cursor\";\n" +
  "    const contextMessages = isCursor ? stripCursorThinking(input.event.messages) : input.event.messages;\n" +
  "    if (input.laneOwnsCompaction) {\n" +
  "        return repairOrphanedToolResults(convertToLlm(contextMessages));\n" +
  "    }\n" +
  "    const admittedMessages = admitContextToolResults(contextMessages, input.contextWindow, input.toolAdmissionEnabled);\n";

export const EMERGENCY_PRUNE_WINDOW_NEEDLE =
  "        : hardLimitEmergencyPrune(sourceMessages, input.promptContextWindow, input.emergencyPruneLatch);\n";

export const EMERGENCY_PRUNE_WINDOW_REPLACEMENT =
  "        : hardLimitEmergencyPrune(sourceMessages, input.contextWindow, input.emergencyPruneLatch);\n";

export const ESTIMATE_WIRE_TOKENS_NEEDLE =
  "function estimateWireTokens(message) {\n" +
  "    const base = estimateTokens(message);\n" +
  "    let serialized;\n" +
  "    try {\n" +
  "        serialized = JSON.stringify(message);\n" +
  "    }\n" +
  "    catch {\n" +
  "        return base;\n" +
  "    }\n" +
  "    return base + Math.ceil(cjkExtraChars(serialized) / 4);\n" +
  "}\n";

export const ESTIMATE_WIRE_TOKENS_REPLACEMENT =
  "function sanitizeForWireEstimate(message) {\n" +
  "    if (message?.role === \"assistant\" && Array.isArray(message.content)) {\n" +
  "        if (message.content.some((b) => b.type === \"thinking\")) {\n" +
  "            return {\n" +
  "                ...message,\n" +
  "                content: message.content.filter((b) => b.type !== \"thinking\"),\n" +
  "            };\n" +
  "        }\n" +
  "    }\n" +
  "    return message;\n" +
  "}\n" +
  "function estimateWireTokens(message) {\n" +
  "    const wireMsg = sanitizeForWireEstimate(message);\n" +
  "    const base = estimateTokens(wireMsg);\n" +
  "    let serialized;\n" +
  "    try {\n" +
  "        serialized = JSON.stringify(wireMsg);\n" +
  "    }\n" +
  "    catch {\n" +
  "        return base;\n" +
  "    }\n" +
  "    return base + Math.ceil(cjkExtraChars(serialized) / 4);\n" +
  "}\n";

export const PRUNE_TO_BUDGET_NEEDLE =
  "export function pruneOldMessagesToBudget(messages, targetTokens) {\n" +
  "    let pruned = messages;\n" +
  "    let total = estimateTotalTokens(pruned);\n" +
  "    while (total > targetTokens) {\n" +
  "        const boundaryIndex = findLastUserLikeIndex(pruned);\n" +
  "        const next = removeFirstOldToolPair(pruned, boundaryIndex) ?? removeFirstOldMessage(pruned, boundaryIndex);\n" +
  "        if (!next || next.messages.length === pruned.length)\n" +
  "            break;\n" +
  "        pruned = next.messages;\n" +
  "        total -= next.removedTokens;\n" +
  "    }\n" +
  "    return pruned;\n" +
  "}\n";

export const PRUNE_TO_BUDGET_REPLACEMENT =
  "export function pruneOldMessagesToBudget(messages, targetTokens) {\n" +
  "    const boundaryIndex = findLastUserLikeIndex(messages);\n" +
  "    const tokenMap = new Array(messages.length);\n" +
  "    let total = 0;\n" +
  "    for (let i = 0; i < messages.length; i++) {\n" +
  "        const t = estimateWireTokens(messages[i]);\n" +
  "        tokenMap[i] = t;\n" +
  "        total += t;\n" +
  "    }\n" +
  "    if (total <= targetTokens) {\n" +
  "        return messages;\n" +
  "    }\n" +
  "    const assistantToolCallIds = messages.map((m) => getToolCallIds(m));\n" +
  "    const toolResultIndicesByCallId = new Map();\n" +
  "    for (let i = 0; i < messages.length; i++) {\n" +
  "        const m = messages[i];\n" +
  "        if (m && m.role === \"toolResult\" && m.toolCallId) {\n" +
  "            let list = toolResultIndicesByCallId.get(m.toolCallId);\n" +
  "            if (!list) {\n" +
  "                list = [];\n" +
  "                toolResultIndicesByCallId.set(m.toolCallId, list);\n" +
  "            }\n" +
  "            list.push(i);\n" +
  "        }\n" +
  "    }\n" +
  "    const toRemove = new Set();\n" +
  "    const visitedCallIds = new Set();\n" +
  "    const removeIndices = (indices) => {\n" +
  "        for (const idx of indices) {\n" +
  "            if (!toRemove.has(idx)) {\n" +
  "                toRemove.add(idx);\n" +
  "                total -= tokenMap[idx];\n" +
  "            }\n" +
  "        }\n" +
  "    };\n" +
  "    for (let i = 0; i < boundaryIndex && total > targetTokens; i++) {\n" +
  "        if (toRemove.has(i)) continue;\n" +
  "        const m = messages[i];\n" +
  "        if (!m) continue;\n" +
  "        const ids = assistantToolCallIds[i];\n" +
  "        if (m.role === \"assistant\" && ids.size > 0) {\n" +
  "            const pair = [i];\n" +
  "            for (const id of ids) {\n" +
  "                if (visitedCallIds.has(id)) continue;\n" +
  "                visitedCallIds.add(id);\n" +
  "                const results = toolResultIndicesByCallId.get(id);\n" +
  "                if (results) {\n" +
  "                    for (const rIdx of results) pair.push(rIdx);\n" +
  "                }\n" +
  "            }\n" +
  "            removeIndices(pair);\n" +
  "        } else if (m.role === \"toolResult\") {\n" +
  "            removeIndices([i]);\n" +
  "        }\n" +
  "    }\n" +
  "    for (let i = 0; i < boundaryIndex && total > targetTokens; i++) {\n" +
  "        if (toRemove.has(i)) continue;\n" +
  "        const m = messages[i];\n" +
  "        if (!m || m.role === \"toolResult\") continue;\n" +
  "        const ids = assistantToolCallIds[i];\n" +
  "        if (m.role === \"assistant\" && ids.size > 0) {\n" +
  "            const pair = [i];\n" +
  "            for (const id of ids) {\n" +
  "                if (visitedCallIds.has(id)) continue;\n" +
  "                visitedCallIds.add(id);\n" +
  "                const results = toolResultIndicesByCallId.get(id);\n" +
  "                if (results) {\n" +
  "                    for (const rIdx of results) pair.push(rIdx);\n" +
  "                }\n" +
  "            }\n" +
  "            removeIndices(pair);\n" +
  "        } else {\n" +
  "            removeIndices([i]);\n" +
  "        }\n" +
  "    }\n" +
  "    if (toRemove.size === 0) return messages;\n" +
  "    return messages.filter((_, idx) => !toRemove.has(idx));\n" +
  "}\n";

export function isCompactionContextPipelineUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/context-pipeline.js");
}

export function isCompactionOverflowRetryUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/overflow-retry.js");
}

/**
 * Cursor 모델의 과거 턴 thinking 블록을 컴팩션 파이프라인에서 제거하고,
 * 긴급 컴팩션 대상 윈도우를 promptContextWindow 대신 contextWindow 기준으로 바로잡아
 * maxTokens 과대 차감에 따른 조기 긴급 프루닝(82% / 50% 등)을 방지하고 95% 비상선으로 정상화한다.
 */
export function injectCompactionContextPipeline(source) {
  let next = replaceOnce(
    source,
    CONTEXT_PIPELINE_NEEDLE,
    CONTEXT_PIPELINE_REPLACEMENT,
    "compaction context-pipeline stripCursorThinking",
  );
  return replaceOnce(
    next,
    EMERGENCY_PRUNE_WINDOW_NEEDLE,
    EMERGENCY_PRUNE_WINDOW_REPLACEMENT,
    "compaction context-pipeline normalize hardLimitEmergencyPrune window",
  );
}

/**
 * pruneOldMessagesToBudget 을 O(N^2) 반복 필터링/직렬화에서 O(N) 단일 패스로 최적화하고,
 * estimateWireTokens 에서 thinking 블록을 제외하여 요약 입력 및 긴급 컴팩션의 허수 계상을 방지한다.
 */
export function injectCompactionOverflowRetry(source) {
  let next = replaceOnce(
    source,
    ESTIMATE_WIRE_TOKENS_NEEDLE,
    ESTIMATE_WIRE_TOKENS_REPLACEMENT,
    "compaction overflow-retry estimateWireTokens sanitize",
  );
  return replaceOnce(
    next,
    PRUNE_TO_BUDGET_NEEDLE,
    PRUNE_TO_BUDGET_REPLACEMENT,
    "compaction overflow-retry O(N) pruneOldMessagesToBudget",
  );
}
