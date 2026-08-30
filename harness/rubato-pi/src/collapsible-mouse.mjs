const ASSISTANT_MARKER = "rubato.collapsibleMouse.assistantInjected";
const TOOL_EXECUTION_MARKER = "rubato.collapsibleMouse.toolExecutionInjected";
const TOOL_GROUP_MARKER = "rubato.collapsibleMouse.toolGroupInjected";
const TUI_MARKER = "rubato.collapsibleMouse.routingInjected";

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato collapsible mouse transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function isCollapsibleAssistantUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js");
}

export function isCollapsibleToolExecutionUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js");
}

export function isCollapsibleToolGroupUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/tool-group.js");
}

export function actionLineMarker(url) {
  return `\x1b]8;;${url}\x1b\\\x1b]8;;\x1b\\`;
}

export function injectCollapsibleAssistant(source) {
  if (source.includes(ASSISTANT_MARKER)) return source;
  let next = replaceOnce(
    source,
    "export class AssistantMessageComponent extends Container {",
    `// ${ASSISTANT_MARKER}\nclass RubatoThinkingMarkdown extends Markdown {\n    constructor(action, ...args) {\n        super(...args);\n        this.action = action;\n    }\n    render(width) {\n        const marker = \`\\x1b]8;;\${this.action.url}\\x1b\\\\\\x1b]8;;\\x1b\\\\\`;\n        return super.render(width).map((line) => marker + line);\n    }\n}\nexport class AssistantMessageComponent extends Container {`,
    "assistant marker component",
  );
  next = replaceOnce(
    next,
    "                return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme, {\n                    color: (text) => theme.fg(\"thinkingText\", text),",
    "                return new RubatoThinkingMarkdown(this.thinkingAction, descriptor.text, this.outputPad, 0, this.markdownTheme, {\n                    color: (text) => theme.fg(\"thinkingText\", text),",
    "thinking markdown",
  );
  next = replaceOnce(
    next,
    "                return new Text(hyperlink(descriptor.text, this.thinkingAction.url), this.outputPad, 0);",
    "                return new Text(`\\x1b]8;;${this.thinkingAction.url}\\x1b\\\\\\x1b]8;;\\x1b\\\\` + hyperlink(descriptor.text, this.thinkingAction.url), this.outputPad, 0);",
    "thinking label",
  );
  return next;
}

export function injectCollapsibleToolExecution(source) {
  if (source.includes(TOOL_EXECUTION_MARKER)) return source;
  return replaceOnce(
    source,
    "        if (!this.isExpanded) {\n            lines = collapseToolLines(lines, this.result?.isError === true).map((line) => hyperlink(line, this.toggleAction.url));\n        }",
    `        // ${TOOL_EXECUTION_MARKER}\n        if (this.expanded) {\n            const marker = \`\\x1b]8;;\${this.toggleAction.url}\\x1b\\\\\\x1b]8;;\\x1b\\\\\`;\n            lines = lines.map((line) => marker + line);\n        }\n        else if (!this.isExpanded) {\n            lines = collapseToolLines(lines, this.result?.isError === true).map((line) => hyperlink(line, this.toggleAction.url));\n        }`,
    "expanded tool lines",
  );
}

export function injectCollapsibleToolGroup(source) {
  if (source.includes(TOOL_GROUP_MARKER)) return source;
  return replaceOnce(
    source,
    "        if (this.expanded) return super.render(width);",
    `        // ${TOOL_GROUP_MARKER}\n        if (this.expanded) {\n            const marker = \`\\x1b]8;;\${this.toggleAction.url}\\x1b\\\\\\x1b]8;;\\x1b\\\\\`;\n            return super.render(width).map((line) => marker + line);\n        }`,
    "expanded tool group",
  );
}

export function injectCollapsibleMouseRouting(source) {
  if (source.includes(TUI_MARKER)) return source;
  let next = replaceOnce(
    source,
    "const wordSegmenter = getWordSegmenter();",
    `const wordSegmenter = getWordSegmenter();\n// ${TUI_MARKER}\nfunction getRubatoCollapseUrl(line) {\n    return /\\x1b\\]8;;(senpi-action:\\d+)\\x1b\\\\\\x1b\\]8;;\\x1b\\\\/.exec(line)?.[1];\n}`,
    "routing helper",
  );
  next = replaceOnce(
    next,
    "        this.pressedUrl = range\n            ? undefined\n            : getOsc8LinkAtColumn(this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? \"\", Math.max(0, Math.min(this.terminal.columns - 1, event.x)));",
    "        this.pressedUrl = range\n            ? undefined\n            : getOsc8LinkAtColumn(this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? \"\", Math.max(0, Math.min(this.terminal.columns - 1, event.x))) ??\n                getRubatoCollapseUrl(this.getSelectionSourceLine(anchor));",
    "pressed action lookup",
  );
  return next;
}
