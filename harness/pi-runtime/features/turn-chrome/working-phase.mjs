// What the working dock says it is doing right now.
//
// Stock opens one "Working" indicator at turn_start and keeps that single word
// for the whole turn, so thinking and executing look identical. Reading the
// tail of the streaming assistant message tells them apart: a trailing thinking
// block means we are still thinking, text or a tool call means work started.
//
// Stock already releases the dock on agent_end (interactive-mode.js
// clearStatusIndicator("working") in the agent_end case), so only the label
// distinction is missing here.

export const THINKING_LABEL = "Thinking";
export const WORKING_LABEL = "Working";

/**
 * @param {{ content?: ReadonlyArray<{ type?: string, text?: string }> }} [message]
 * @returns {"Thinking" | "Working" | undefined} undefined when nothing decides it
 */
export function nextWorkingLabel(message) {
  const content = message?.content ?? [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block) continue;
    if (block.type === "toolCall") return WORKING_LABEL;
    if (block.type === "text") {
      // An empty text block is a slot the stream just opened; the thinking
      // block before it still owns the phase.
      if (String(block.text ?? "").length > 0) return WORKING_LABEL;
      continue;
    }
    if (block.type === "thinking") return THINKING_LABEL;
  }
  return undefined;
}
