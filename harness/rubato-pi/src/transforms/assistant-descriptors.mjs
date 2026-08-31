import { replaceOnce } from "./replace-once.mjs";

export function isAssistantDescriptorsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/assistant-render-descriptors.js");
}

/** #17 per-run hide + #18 hideTurnWork + #25 ellipsis + #27 abort-once. */
export function injectAssistantDescriptors(source) {
  let next = replaceOnce(
    source,
    `function isVisibleContent(content, providerNativeVisible) {
    switch (content.type) {`,
    `function isToolUseEllipsisFiller(message, content) {
    const isToolUseTurn = message.stopReason === "toolUse" || message.stopReason === "pending";
    return isToolUseTurn &&
        content.type === "text" &&
        /^(?:\\.{3,}|…+)$/.test(content.text.trim());
}
function isVisibleContent(message, content, providerNativeVisible) {
    if (isToolUseEllipsisFiller(message, content))
        return false;
    switch (content.type) {`,
    "descriptors ellipsis + isVisibleContent signature",
  );
  next = replaceOnce(
    next,
    `export function createAssistantRenderDescriptors(message, options) {
    const descriptors = [];
    if (message.content.some((content) => isVisibleContent(content, true)))
        descriptors.push(SPACER_DESCRIPTOR);`,
    `export function createAssistantRenderDescriptors(message, options) {
    const descriptors = [];
    const isTurnVisible = (content, providerNativeVisible) => !(options.hideTurnWork && content.type === "thinking") && isVisibleContent(message, content, providerNativeVisible);
    if (message.content.some((content) => isTurnVisible(content, true)))
        descriptors.push(SPACER_DESCRIPTOR);`,
    "descriptors isTurnVisible",
  );
  next = replaceOnce(
    next,
    `            case "text": {
                const text = content.text.trim();`,
    `            case "text": {
                if (isToolUseEllipsisFiller(message, content))
                    break;
                const text = content.text.trim();`,
    "descriptors skip ellipsis text",
  );
  next = replaceOnce(
    next,
    `                if (thinkingBlocks.length === 0)
                    break;
                if (!hasTiming) {
                    const text = options.hideThinkingBlock
                        ? theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel))
                        : thinkingBlocks.join("\\n\\n");
                    descriptors.push({ kind: options.hideThinkingBlock ? "thinking-label" : "thinking-md", text });
                }
                else {
                    const label = isDone
                        ? theme.italic(theme.fg("thinkingText", \`Thought: \${formatDuration(Math.max(0, maxEnd - minStart))}\`))
                        : theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel));
                    if (options.hideThinkingBlock) {
                        descriptors.push({ kind: "thinking-label", text: label });
                    }
                    else {
                        descriptors.push({ kind: "thinking-label", text: label }, { kind: "thinking-md", text: thinkingBlocks.join("\\n\\n") });
                    }
                }
                if (message.content.slice(i + 1).some((following) => isVisibleContent(following, false)))
                    descriptors.push(SPACER_DESCRIPTOR);`,
    `                if (thinkingBlocks.length === 0)
                    break;
                if (options.hideTurnWork)
                    break;
                // 접힘은 메시지가 아니라 **사고 런 단위**로 정해진다. 한 메시지 안에
                // 끝난 런과 흐르는 런이 공존하므로(도구 호출 사이에 다시 생각할 때),
                // 불리언 하나로는 "앞은 접고 뒤는 펼침"을 표현할 수 없다.
                const hideThisRun = typeof options.hideThinkingBlock === "function"
                    ? options.hideThinkingBlock({ isDone, hasTiming, startedAt: minStart })
                    : options.hideThinkingBlock;
                if (!hasTiming) {
                    const text = hideThisRun
                        ? theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel))
                        : thinkingBlocks.join("\\n\\n");
                    descriptors.push({ kind: hideThisRun ? "thinking-label" : "thinking-md", text });
                }
                else {
                    const label = isDone
                        ? theme.italic(theme.fg("thinkingText", \`Thought: \${formatDuration(Math.max(0, maxEnd - minStart))}\`))
                        : theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel));
                    if (hideThisRun) {
                        descriptors.push({ kind: "thinking-label", text: label });
                    }
                    else {
                        descriptors.push({ kind: "thinking-label", text: label }, { kind: "thinking-md", text: thinkingBlocks.join("\\n\\n") });
                    }
                }
                if (message.content.slice(i + 1).some((following) => isTurnVisible(following, false)))
                    descriptors.push(SPACER_DESCRIPTOR);`,
    "descriptors per-run thinking hide",
  );
  next = replaceOnce(
    next,
    "if (message.content.slice(i + 1).some((following) => isVisibleContent(following, true)))",
    "if (message.content.slice(i + 1).some((following) => isTurnVisible(following, true)))",
    "descriptors providerNative isTurnVisible",
  );
  next = replaceOnce(
    next,
    `        case "aborted": {
            if (options.hasToolCalls)
                break;
            const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"`,
    `        case "aborted": {
            const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"`,
    "descriptors abort-once",
  );
  next = replaceOnce(
    next,
    "//# sourceMappingURL=assistant-render-descriptors.js.map",
    "//# sourceMappingURL=assistant-render-descriptors.js.map\n",
    "descriptors sourcemap newline",
  );
  return next;
}
