// Turn chrome: how one turn looks while it runs and after it ends.
//
// Stock paints every tool call raw, keeps one "Working" word for the whole
// turn, and leaves the turn's thinking and narration on screen forever. This
// feature restores the Rubato reading: consecutive tool calls collapse into one
// line, the dock says Thinking or Working, and when the turn ends its work
// folds into a single summary line that a click reopens.
//
// Ported as one unit from harness/rubato-pi/src/transforms/{tool-group-component,
// tool-execution, interactive-mode-chrome, turn-work-summary, working-phase,
// assistant-message, assistant-descriptors, assistant-phase, core-descriptors,
// internal-actions}.mjs. Stock differences that changed the port:
//   - stock has no assistant-render-descriptors.js; assistant-message.js paints
//     content directly, so the descriptor hunks live in that component instead
//   - stock already toggles thinking by MouseRegion click and already releases
//     the working dock on agent_end, so those are left alone
//   - the OSC-8 internal-action bus is replaced by component handleMouse
import { fileURLToPath } from "node:url";

const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const RUNTIME_DIR = "dist/rubato-features/turn-chrome";
const OWNED = ["assistant-phase.mjs", "working-phase.mjs", "tool-group.mjs", "turn-work-summary.mjs"];

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[turn-chrome:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[turn-chrome:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[turn-chrome:" + label + "] expected pristine feature seam");
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: AGENT_PACKAGE, version: VERSION, path, preimageSha256, apply });
}

// ---------------------------------------------------------------- tool chrome

const TE_THEME_IMPORT = 'import { theme } from "../theme/theme.js";\n';
const TE_ANSI_IMPORT = 'import { stripAnsi } from "../../../utils/ansi.js";\n';

const TE_CLASS_HEAD = "const FALLBACK_PREVIEW_LINES = 10;\nexport class ToolExecutionComponent extends Container {";
const TE_CLASS_HEAD_NEXT = [
  "const FALLBACK_PREVIEW_LINES = 10;",
  "/** Tools whose result IS the content: collapsing them leaves nothing to read. */",
  'const ALWAYS_EXPANDED_TOOLS = new Set(["todo", "task"]);',
  "const COLLAPSED_ERROR_TAIL_MAX_LENGTH = 160;",
  "/** A collapsed tool is its first meaningful line, plus the error tail if it failed. */",
  "function collapseToolLines(lines, isError) {",
  "    const nonEmpty = lines.filter((line) => stripAnsi(line).trim().length > 0);",
  '    const first = nonEmpty[0] ?? lines[0] ?? "";',
  "    if (!isError)",
  "        return [first];",
  '    let tail = nonEmpty[nonEmpty.length - 1] ?? "";',
  "    if (tail.length > COLLAPSED_ERROR_TAIL_MAX_LENGTH)",
  '        tail = "..." + tail.slice(-(COLLAPSED_ERROR_TAIL_MAX_LENGTH - 3));',
  "    return first === tail ? [first] : [first, tail];",
  "}",
  "export class ToolExecutionComponent extends Container {",
].join("\n");

const TE_FIELD = "    hideComponent = false;\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {\n        super();\n        this.toolName = toolName;";
const TE_FIELD_NEXT = "    hideComponent = false;\n    alwaysExpanded = false;\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {\n        super();\n        this.alwaysExpanded = ALWAYS_EXPANDED_TOOLS.has(toolName);\n        this.toolName = toolName;";

const TE_GETTER_AT = "    getCallRenderer() {";
const TE_GETTER = [
  "    /** todo/task ignore the collapse: their result is the whole point. */",
  "    get isExpanded() {",
  "        return this.alwaysExpanded || this.expanded;",
  "    }",
  "    getCallRenderer() {",
].join("\n");

const TE_RENDER = "    render(width) {\n        if (this.hideComponent) {\n            return [];\n        }\n";
const TE_RENDER_NEXT = [
  "    render(width) {",
  "        if (this.hideComponent) {",
  "            return [];",
  "        }",
  "        if (!this.isExpanded)",
  "            return collapseToolLines(this.renderFullOutput(width), this.result?.isError === true);",
  "        return this.renderFullOutput(width);",
  "    }",
  "    renderFullOutput(width) {",
  "",
].join("\n");

const TE_MOUSE = "    handleMouse(event) {\n        if (!this.hasRendererDefinition() || this.getRenderShell() !== \"self\")";
const TE_MOUSE_NEXT = [
  "    handleMouse(event) {",
  "        if (!this.isExpanded) {",
  '            if (event.type !== "click" || event.button !== "left")',
  "                return undefined;",
  "            this.setExpanded(true);",
  "            this.ui.requestRender();",
  "            return { handled: true };",
  "        }",
  '        if (!this.hasRendererDefinition() || this.getRenderShell() !== "self")',
].join("\n");

export function patchToolExecution(source) {
  unpatched(source, "ALWAYS_EXPANDED_TOOLS", "tool-execution");
  let next = replaceOnce(source, TE_THEME_IMPORT, TE_THEME_IMPORT + TE_ANSI_IMPORT, "tool-ansi-import");
  next = replaceOnce(next, TE_CLASS_HEAD, TE_CLASS_HEAD_NEXT, "tool-collapse-helper");
  next = replaceOnce(next, TE_FIELD, TE_FIELD_NEXT, "tool-always-expanded");
  next = replaceOnce(next, TE_GETTER_AT, TE_GETTER, "tool-is-expanded");
  next = replaceOnce(next, "        const displayLines = this.expanded ? lines", "        const displayLines = this.isExpanded ? lines", "tool-fallback-expanded");
  next = replaceOnce(next, "            expanded: this.expanded,\n            showImages: this.showImages,", "            expanded: this.isExpanded,\n            showImages: this.showImages,", "tool-context-expanded");
  next = replaceOnce(next, "{ expanded: this.expanded, isPartial: this.isPartial }", "{ expanded: this.isExpanded, isPartial: this.isPartial }", "tool-result-expanded");
  next = replaceOnce(next, TE_RENDER, TE_RENDER_NEXT, "tool-collapse-render");
  next = replaceOnce(next, TE_MOUSE, TE_MOUSE_NEXT, "tool-collapse-click");
  return next;
}

// ----------------------------------------------------------- assistant chrome

const AM_THEME_IMPORT = 'import { getMarkdownTheme, theme } from "../theme/theme.js";\n';
const AM_PHASE_IMPORT = 'import { isToolUseEllipsisFiller, phaseForTextContent } from "../../../rubato-features/turn-chrome/assistant-phase.mjs";\n';

const AM_FIELDS = "    isStreaming = false;\n    thinkingVisibilityOverrides = new Map();";
const AM_FIELDS_NEXT = "    isStreaming = false;\n    turnWorkCollapsed = false;\n    hideProgress = false;\n    showAbortWithTools = false;\n    thinkingVisibilityOverrides = new Map();";

const AM_METHODS_AT = "    setOutputPad(padding) {";
const AM_METHODS = [
  "    /** The turn ended: fold this message's thinking into the turn summary. */",
  "    setTurnWorkCollapsed(collapsed) {",
  "        if (this.turnWorkCollapsed === collapsed)",
  "            return;",
  "        this.turnWorkCollapsed = collapsed;",
  "        if (this.lastMessage) {",
  "            this.updateContent(this.lastMessage);",
  "        }",
  "    }",
  "    /** Progress narration is scaffolding for the answer, not the answer. */",
  "    setHideProgress(hide) {",
  "        if (this.hideProgress === hide)",
  "            return;",
  "        this.hideProgress = hide;",
  "        if (this.lastMessage) {",
  "            this.updateContent(this.lastMessage);",
  "        }",
  "    }",
  "    isHiddenByTurnChrome(message, content) {",
  '        if (content.type === "thinking")',
  "            return this.turnWorkCollapsed;",
  '        if (content.type !== "text")',
  "            return false;",
  "        if (isToolUseEllipsisFiller(message, content))",
  "            return true;",
  '        return this.hideProgress && phaseForTextContent(content, message) === "progress";',
  "    }",
  "    /**",
  "     * Only the live turn: interactive-mode stopped stamping each pending tool",
  "     * with the cancel, so this message owns the single line. Replayed history",
  "     * still carries the per-tool result and must not print it twice.",
  "     */",
  "    setShowAbortWithTools(show) {",
  "        if (this.showAbortWithTools === show)",
  "            return;",
  "        this.showAbortWithTools = show;",
  "        if (this.lastMessage) {",
  "            this.updateContent(this.lastMessage);",
  "        }",
  "    }",
  "    setOutputPad(padding) {",
].join("\n");

const AM_VISIBLE = '        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));';
const AM_VISIBLE_NEXT = '        const hasVisibleContent = message.content.some((c) => !this.isHiddenByTurnChrome(message, c) && ((c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())));';

const AM_TEXT = '            if (content.type === "text" && content.text.trim()) {';
const AM_TEXT_NEXT = '            if (content.type === "text" && content.text.trim() && !this.isHiddenByTurnChrome(message, content)) {';

const AM_THINKING_SKIP = "                if (thinkingBlocks.length === 0) {\n                    continue;\n                }";
const AM_THINKING_SKIP_NEXT = "                if (thinkingBlocks.length === 0 || this.turnWorkCollapsed) {\n                    continue;\n                }";

const AM_AFTER = '                const hasVisibleContentAfter = message.content\n                    .slice(i + 1)\n                    .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));';
const AM_AFTER_NEXT = '                const hasVisibleContentAfter = message.content\n                    .slice(i + 1)\n                    .some((c) => !this.isHiddenByTurnChrome(message, c) && ((c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())));';

// Abort is a turn-level event. interactive-mode no longer stamps every pending
// tool with it, so the message itself must own the one line.
const AM_ABORT = '        else if (!hasToolCalls) {\n            if (message.stopReason === "aborted") {';
const AM_ABORT_NEXT = '        else if (!hasToolCalls || (this.showAbortWithTools && message.stopReason === "aborted")) {\n            if (message.stopReason === "aborted") {';

export function patchAssistantMessage(source) {
  unpatched(source, "isHiddenByTurnChrome", "assistant-message");
  let next = replaceOnce(source, AM_THEME_IMPORT, AM_THEME_IMPORT + AM_PHASE_IMPORT, "assistant-phase-import");
  next = replaceOnce(next, AM_FIELDS, AM_FIELDS_NEXT, "assistant-turn-fields");
  next = replaceOnce(next, AM_METHODS_AT, AM_METHODS, "assistant-turn-methods");
  next = replaceOnce(next, AM_VISIBLE, AM_VISIBLE_NEXT, "assistant-visible-filter");
  next = replaceOnce(next, AM_TEXT, AM_TEXT_NEXT, "assistant-text-filter");
  next = replaceOnce(next, AM_THINKING_SKIP, AM_THINKING_SKIP_NEXT, "assistant-thinking-skip");
  next = replaceOnce(next, AM_AFTER, AM_AFTER_NEXT, "assistant-spacer-filter");
  next = replaceOnce(next, AM_ABORT, AM_ABORT_NEXT, "assistant-abort-once");
  return next;
}

// ----------------------------------------------------------- interactive mode

const IM_STATUS_IMPORT = 'import { BranchSummaryStatusIndicator, CompactionStatusIndicator, IdleStatus, RetryStatusIndicator, WorkingStatusIndicator, } from "./components/status-indicator.js";';
const IM_CHROME_IMPORTS = [
  IM_STATUS_IMPORT,
  'import { ToolGroupComponent } from "../../rubato-features/turn-chrome/tool-group.mjs";',
  'import { TurnWorkSummaryComponent } from "../../rubato-features/turn-chrome/turn-work-summary.mjs";',
  'import { THINKING_LABEL, nextWorkingLabel } from "../../rubato-features/turn-chrome/working-phase.mjs";',
  'import { assistantPaintsText } from "../../rubato-features/turn-chrome/assistant-phase.mjs";',
].join("\n");

const IM_HELPERS_AT = "    addCustomEntryToChat(entry) {";
const IM_HELPERS = [
  "    /** Put this tool in the open group, or start one; ungroupable tools break it. */",
  "    attachToolComponent(toolName, args, component) {",
  "        if (!ToolGroupComponent.canGroup(toolName, args)) {",
  "            this.closeToolGroup();",
  "            this.chatContainer.addChild(component);",
  "            return;",
  "        }",
  "        this.settleToolGroupPosition();",
  "        if (!this.activeToolGroup) {",
  "            this.activeToolGroup = new ToolGroupComponent(this.ui);",
  "            this.chatContainer.addChild(this.activeToolGroup);",
  "            this.turnWorkSummary?.trackToolGroup(this.activeToolGroup);",
  "        }",
  "        this.activeToolGroup.addTool(component);",
  "    }",
  "    /**",
  "     * A provider may send one tool call per assistant message, so a group has to",
  "     * survive message boundaries; an empty streaming component or a thinking-only",
  "     * message is not a reason to split. Prose does split it. Extending a group",
  "     * that is no longer last moves it to the tail so the order still reads.",
  "     */",
  "    settleToolGroupPosition() {",
  "        if (!this.activeToolGroup)",
  "            return;",
  "        const children = this.chatContainer.children;",
  "        for (let index = children.length - 1; index >= 0; index -= 1) {",
  "            const child = children[index];",
  "            if (child === this.activeToolGroup) {",
  "                if (index !== children.length - 1) {",
  "                    children.splice(index, 1);",
  "                    children.push(this.activeToolGroup);",
  "                }",
  "                return;",
  "            }",
  "            if (child instanceof AssistantMessageComponent && !assistantPaintsText(child.lastMessage))",
  "                continue;",
  "            this.closeToolGroup();",
  "            return;",
  "        }",
  "        this.closeToolGroup();",
  "    }",
  "    closeToolGroup() {",
  "        this.activeToolGroup = undefined;",
  "    }",
  "    startTurnWorkSummary() {",
  "        if (this.turnWorkSummary)",
  "            return;",
  "        this.turnWorkSummary = new TurnWorkSummaryComponent(this.ui);",
  "        this.chatContainer.addChild(this.turnWorkSummary);",
  "    }",
  "    /** Thinking or Working: the tail of the streaming message says which. */",
  "    applyWorkingPhase(message) {",
  "        const label = nextWorkingLabel(message);",
  "        if (!label || this.workingPhaseLabel === label)",
  "            return;",
  "        this.workingPhaseLabel = label;",
  '        if (this.workingMessage === undefined && this.activeStatusIndicator?.kind === "working") {',
  "            this.activeStatusIndicator.setMessage(label);",
  "        }",
  "    }",
  "    addCustomEntryToChat(entry) {",
].join("\n");

const IM_AGENT_START = '            case "agent_start":\n                this.pendingTools.clear();';
const IM_AGENT_START_NEXT = [
  '            case "agent_start":',
  "                this.pendingTools.clear();",
  "                this.closeToolGroup();",
  "                // The summary belongs above the turn's own output, and the user",
  "                // message has not been added yet at agent_start, so only reset",
  "                // here; message_start creates the component in place.",
  "                this.turnWorkSummary = undefined;",
  "                this.workingPhaseLabel = THINKING_LABEL;",
].join("\n");

const IM_WORKING_INDICATOR = "new WorkingStatusIndicator(this.ui, this.workingMessage ?? this.defaultWorkingMessage,";
const IM_WORKING_INDICATOR_NEXT = "new WorkingStatusIndicator(this.ui, this.workingMessage ?? this.workingPhaseLabel ?? this.defaultWorkingMessage,";

const IM_MESSAGE_START = [
  '                else if (event.message.role === "assistant") {',
  "                    this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());",
  "                    this.streamingMessage = event.message;",
  "                    this.chatContainer.addChild(this.streamingComponent);",
  "                    this.streamingComponent.updateContent(this.streamingMessage, true);",
].join("\n");
const IM_MESSAGE_START_NEXT = [
  '                else if (event.message.role === "assistant") {',
  "                    this.startTurnWorkSummary();",
  "                    this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());",
  "                    this.streamingMessage = event.message;",
  "                    this.chatContainer.addChild(this.streamingComponent);",
  "                    this.turnWorkSummary?.trackAssistant(this.streamingComponent, this.streamingMessage);",
  "                    this.applyWorkingPhase(this.streamingMessage);",
  "                    this.streamingComponent.updateContent(this.streamingMessage, true);",
].join("\n");

const IM_MESSAGE_UPDATE = [
  "                    this.streamingComponent.updateContent(this.streamingMessage, true);",
  "                    for (const content of this.streamingMessage.content) {",
  '                        if (content.type === "toolCall") {',
  "                            if (!this.pendingTools.has(content.id)) {",
].join("\n");
const IM_MESSAGE_UPDATE_NEXT = [
  "                    this.turnWorkSummary?.trackAssistant(this.streamingComponent, this.streamingMessage);",
  "                    this.applyWorkingPhase(this.streamingMessage);",
  "                    this.streamingComponent.updateContent(this.streamingMessage, true);",
  "                    for (const [contentIndex, content] of this.streamingMessage.content.entries()) {",
  '                        if (content.type === "toolCall") {',
  "                            if (!this.pendingTools.has(content.id)) {",
  "                                // One update can carry new prose and the tool that",
  "                                // follows it. Body order decides the grouping, not",
  "                                // arrival time, so close the group here.",
  '                                const previous = contentIndex > 0 ? this.streamingMessage.content[contentIndex - 1] : undefined;',
  '                                if (previous?.type === "text" && String(previous.text ?? "").trim())',
  "                                    this.closeToolGroup();",
].join("\n");

const IM_MESSAGE_UPDATE_ATTACH = [
  "                                component.setExpanded(this.toolOutputExpanded);",
  "                                this.chatContainer.addChild(component);",
  "                                this.pendingTools.set(content.id, component);",
].join("\n");
const IM_MESSAGE_UPDATE_ATTACH_NEXT = [
  "                                component.setExpanded(this.toolOutputExpanded);",
  "                                this.attachToolComponent(content.name, content.arguments, component);",
  "                                this.pendingTools.set(content.id, component);",
].join("\n");

const IM_ABORT = [
  '                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {',
  "                        if (!errorMessage) {",
].join("\n");
const IM_ABORT_NEXT = [
  '                    if (this.streamingMessage.stopReason === "aborted") {',
  "                        // Cancel is one turn-level event; stamping every pending tool",
  '                        // reprints "Operation aborted" once per call. The assistant',
  "                        // message owns that line now.",
  "                        this.streamingComponent.setShowAbortWithTools?.(true);",
  '                        this.turnWorkSummary?.setRequestCompleted(false, "interrupted");',
  "                        this.pendingTools.clear();",
  "                    }",
  '                    else if (this.streamingMessage.stopReason === "error") {',
  "                        if (!errorMessage) {",
].join("\n");

const IM_TOOL_START = [
  "                    component.setExpanded(this.toolOutputExpanded);",
  "                    this.chatContainer.addChild(component);",
  "                    this.pendingTools.set(event.toolCallId, component);",
].join("\n");
const IM_TOOL_START_NEXT = [
  "                    component.setExpanded(this.toolOutputExpanded);",
  "                    this.attachToolComponent(event.toolName, event.args, component);",
  "                    this.pendingTools.set(event.toolCallId, component);",
].join("\n");

const IM_TOOL_END = [
  "                    component.updateResult({ ...event.result, isError: event.isError });",
  "                    this.pendingTools.delete(event.toolCallId);",
].join("\n");
const IM_TOOL_END_NEXT = [
  "                    component.updateResult({ ...event.result, isError: event.isError });",
  "                    // The group line carries counts, colors and diff totals.",
  "                    this.activeToolGroup?.refresh();",
  "                    this.pendingTools.delete(event.toolCallId);",
].join("\n");

const IM_AGENT_END = '            case "agent_end":\n                if (this.settingsManager.getShowTerminalProgress()) {\n                    this.ui.terminal.setProgress(false);\n                }\n                this.clearStatusIndicator("working");';
const IM_AGENT_END_NEXT = [
  '            case "agent_end":',
  "                if (this.settingsManager.getShowTerminalProgress()) {",
  "                    this.ui.terminal.setProgress(false);",
  "                }",
  '                this.clearStatusIndicator("working");',
  "                this.workingPhaseLabel = undefined;",
  "                this.closeToolGroup();",
  "                // The turn is over: its thinking, tool groups and progress lines",
  "                // fold into the summary line, which a click reopens.",
  "                this.turnWorkSummary?.setRequestCompleted(true);",
  "                this.turnWorkSummary = undefined;",
].join("\n");

const IM_RENDER_ITEMS = "    renderSessionItems(items, options = {}) {\n        this.pendingTools.clear();";
const IM_RENDER_ITEMS_NEXT = "    renderSessionItems(items, options = {}) {\n        this.pendingTools.clear();\n        this.closeToolGroup();\n        this.turnWorkSummary = undefined;";

const IM_HISTORY_ASSISTANT = '            if (message.role === "assistant") {\n                this.addMessageToChat(message);';
const IM_HISTORY_ASSISTANT_NEXT = '            if (message.role === "assistant") {\n                this.closeToolGroup();\n                this.addMessageToChat(message);';

const IM_HISTORY_TOOL = [
  "                        this.chatContainer.addChild(component);",
  '                        if (message.stopReason === "aborted" || message.stopReason === "error") {',
].join("\n");
const IM_HISTORY_TOOL_NEXT = [
  "                        this.attachToolComponent(content.name, content.arguments, component);",
  '                        if (message.stopReason === "aborted" || message.stopReason === "error") {',
].join("\n");

export function patchInteractiveTurnChrome(source) {
  unpatched(source, "attachToolComponent", "interactive-mode");
  let next = replaceOnce(source, IM_STATUS_IMPORT, IM_CHROME_IMPORTS, "chrome-imports");
  next = replaceOnce(next, IM_HELPERS_AT, IM_HELPERS, "chrome-helpers");
  next = replaceOnce(next, IM_AGENT_START, IM_AGENT_START_NEXT, "agent-start-turn-work");
  next = replaceOnce(next, IM_WORKING_INDICATOR, IM_WORKING_INDICATOR_NEXT, "working-phase-label");
  next = replaceOnce(next, IM_MESSAGE_START, IM_MESSAGE_START_NEXT, "message-start-track");
  next = replaceOnce(next, IM_MESSAGE_UPDATE, IM_MESSAGE_UPDATE_NEXT, "message-update-interleave");
  next = replaceOnce(next, IM_MESSAGE_UPDATE_ATTACH, IM_MESSAGE_UPDATE_ATTACH_NEXT, "message-update-attach");
  next = replaceOnce(next, IM_ABORT, IM_ABORT_NEXT, "abort-once");
  next = replaceOnce(next, IM_TOOL_START, IM_TOOL_START_NEXT, "tool-start-attach");
  next = replaceOnce(next, IM_TOOL_END, IM_TOOL_END_NEXT, "tool-end-refresh");
  next = replaceOnce(next, IM_AGENT_END, IM_AGENT_END_NEXT, "agent-end-turn-work");
  next = replaceOnce(next, IM_RENDER_ITEMS, IM_RENDER_ITEMS_NEXT, "history-reset");
  next = replaceOnce(next, IM_HISTORY_ASSISTANT, IM_HISTORY_ASSISTANT_NEXT, "history-close-group");
  next = replaceOnce(next, IM_HISTORY_TOOL, IM_HISTORY_TOOL_NEXT, "history-attach");
  return next;
}

export const files = Object.freeze(OWNED.map((name) => Object.freeze({
  packageName: AGENT_PACKAGE,
  version: VERSION,
  path: RUNTIME_DIR + "/" + name,
  sourcePath: fileURLToPath(new URL("./" + name, import.meta.url)),
})));

export const patches = Object.freeze([
  patch("turn-chrome:tool-execution", "dist/modes/interactive/components/tool-execution.js",
    "3c7859cde2c4c937cd71865b106a8ee01b6a90b112d0fa78fd2da75b6edc6e2c", patchToolExecution),
  patch("turn-chrome:assistant-message", "dist/modes/interactive/components/assistant-message.js",
    "edbd1e712234609d2ad1078edcf960e3b6f549669075f1c5d1a7a4481e2b3d19", patchAssistantMessage),
  patch("turn-chrome:interactive", "dist/modes/interactive/interactive-mode.js",
    "802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf", patchInteractiveTurnChrome),
]);

export const feature = Object.freeze({ id: "turn-chrome", patches, files });
export default feature;
