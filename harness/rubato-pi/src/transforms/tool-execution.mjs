import { replaceOnce } from "./replace-once.mjs";

export function isToolExecutionUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/tool-execution.js");
}

export function toolExecutionInternalActionsHref() {
  return new URL("./internal-actions.mjs", import.meta.url).href;
}

/** Baseline always-expand todo/task + collapse chrome. */
export function injectToolExecution(source, href = toolExecutionInternalActionsHref()) {
  let next = replaceOnce(
    source,
    'import { Container, Spacer } from "@earendil-works/pi-tui";\n',
    'import { Container, hyperlink, Spacer } from "@earendil-works/pi-tui";\nimport { stripAnsi } from "../../../utils/ansi.js";\n',
    "tool-execution imports",
  );
  next = replaceOnce(
    next,
    'import { theme } from "../theme/theme.js";\n',
    `import { theme } from "../theme/theme.js";\nimport { registerInternalAction } from ${JSON.stringify(href)};\n`,
    "tool-execution internal-actions import",
  );
  next = replaceOnce(
    next,
    "const PENDING_RENDER_FRAME_INTERVAL_MS = 80;\nconst FALLBACK_PREVIEW_LINES = 10;\nfunction collapseFallbackResult",
    `const PENDING_RENDER_FRAME_INTERVAL_MS = 80;
const FALLBACK_PREVIEW_LINES = 10;
/** Tools whose result IS the content: collapsing them leaves zero information, so they always render fully expanded. */
const ALWAYS_EXPANDED_TOOLS = new Set(["todo", "task"]);
const COLLAPSED_ERROR_TAIL_MAX_LENGTH = 160;
function collapseFallbackResult`,
    "tool-execution always-expanded set",
  );
  next = replaceOnce(
    next,
    "    return { ...result, content: [{ type: \"text\", text }] };\n}\nexport class ToolExecutionComponent extends Container {",
    `    return { ...result, content: [{ type: "text", text }] };
}
function collapseToolLines(lines, isError) {
    const nonEmpty = lines.filter((line) => stripAnsi(line).trim().length > 0);
    const first = nonEmpty[0] ?? lines[0] ?? "";
    if (!isError)
        return [first];
    const tailSource = nonEmpty[nonEmpty.length - 1] ?? "";
    let tail = tailSource;
    if (tail.length > COLLAPSED_ERROR_TAIL_MAX_LENGTH) {
        tail = \`...\${tail.slice(-(COLLAPSED_ERROR_TAIL_MAX_LENGTH - 3))}\`;
    }
    return [first, theme.fg("error", tail)];
}
export class ToolExecutionComponent extends Container {`,
    "tool-execution collapseToolLines",
  );
  next = replaceOnce(
    next,
    "        this.ui = ui;\n        this.presentation = presentation;\n        const initialState = this.createRenderState();",
    `        this.ui = ui;
        this.presentation = presentation;
        this.alwaysExpanded = ALWAYS_EXPANDED_TOOLS.has(toolName);
        this.toggleAction = registerInternalAction(() => {
            this.setExpanded(!this.expanded);
            this.ui.requestRender();
        });
        const initialState = this.createRenderState();`,
    "tool-execution toggle action",
  );
  next = replaceOnce(
    next,
    "    dispose() {\n        this.stopAnimation();\n        super.dispose();\n    }",
    "    dispose() {\n        this.stopAnimation();\n        this.toggleAction.dispose();\n        super.dispose();\n    }",
    "tool-execution dispose toggle",
  );
  next = replaceOnce(
    next,
    "        this.lastDisplaySignature = undefined;\n        this.updateDisplay();\n    }\n    render(width) {",
    `        this.lastDisplaySignature = undefined;
        this.updateDisplay();
    }
    get isExpanded() {
        return this.alwaysExpanded || this.expanded;
    }
    render(width) {`,
    "tool-execution isExpanded getter",
  );
  next = replaceOnce(
    next,
    "            if (contentLines.length === 0 && imageLines.length === 0)\n                return [];",
    `            if (contentLines.length === 0 && imageLines.length === 0) {
                this.cachedWidth = width;
                this.cachedSignature = signature;
                this.cachedLines = [];
                return [];
            }`,
    "tool-execution empty cache",
  );
  next = replaceOnce(
    next,
    "            lines = super.render(width);\n        }\n        this.cachedWidth = width;",
    `            lines = super.render(width);
        }
        if (!this.isExpanded) {
            lines = collapseToolLines(lines, this.result?.isError === true).map((line) => hyperlink(line, this.toggleAction.url));
        }
        this.cachedWidth = width;`,
    "tool-execution collapse render",
  );
  next = replaceOnce(
    next,
    "            isPartial: this.isPartial,\n            expanded: this.expanded,\n            showImages: this.showImages,",
    "            isPartial: this.isPartial,\n            expanded: this.isExpanded,\n            showImages: this.showImages,",
    "tool-execution render state expanded",
  );
  next = replaceOnce(
    next,
    "//# sourceMappingURL=tool-execution.js.map",
    "//# sourceMappingURL=tool-execution.js.map\n",
    "tool-execution sourcemap newline",
  );
  return next;
}
