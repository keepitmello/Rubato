const INVISIBLE_FORMAT_CHARS = /\p{Cf}/gu;
export function hasVisibleText(text) {
    return text.replace(INVISIBLE_FORMAT_CHARS, "").trim().length > 0;
}
export function hasVisibleAssistantContent(message) {
    return message.content.some((block) => block.type === "toolCall" || (block.type === "text" && hasVisibleText(block.text)));
}
//# sourceMappingURL=visible-text.js.map