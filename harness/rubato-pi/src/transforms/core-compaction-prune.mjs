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

/** Cursor 모델의 과거 턴 thinking 블록을 컴팩션 파이프라인에서 제거해 허수 토큰과 직렬화 부하를 방지한다. */
export function injectCompactionContextPipeline(source) {
  return replaceOnce(
    source,
    CONTEXT_PIPELINE_NEEDLE,
    CONTEXT_PIPELINE_REPLACEMENT,
    "compaction context-pipeline stripCursorThinking",
  );
}

/** pruneOldMessagesToBudget 을 O(N^2) 반복 필터링/직렬화에서 O(N) 단일 패스로 최적화한다. */
export function injectCompactionOverflowRetry(source) {
  return replaceOnce(
    source,
    PRUNE_TO_BUDGET_NEEDLE,
    PRUNE_TO_BUDGET_REPLACEMENT,
    "compaction overflow-retry O(N) pruneOldMessagesToBudget",
  );
}
