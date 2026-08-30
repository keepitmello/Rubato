const EDITOR_MARKER = "rubato.editorMouse.injected";
const TUI_MARKER = "rubato.editorMouse.routingInjected";

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato editor mouse transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function isEditorMouseModuleUrl(url) {
  return url.includes("pi-tui/dist/components/editor.js");
}

export function isEditorMouseTuiUrl(url) {
  return url.includes("pi-tui/dist/tui-alt-screen.js");
}

export function injectEditorMouse(source) {
  if (source.includes(EDITOR_MARKER)) return source;
  let next = replaceOnce(
    source,
    "        this.snappedFromCursorCol = null;\n        // Undo support",
    `        this.snappedFromCursorCol = null;\n        // ${EDITOR_MARKER}\n        this.mouseSelectionAnchor = null;\n        this.mouseSelectionFocus = null;\n        this.mouseSelectionActive = false;\n        this.lastRenderedTop = 0;\n        // Undo support`,
    "editor state",
  );
  next = replaceOnce(
    next,
    "        const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);\n        const result = [];",
    "        const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);\n        this.lastRenderedTop = this.scrollOffset;\n        const result = [];",
    "scroll coordinates",
  );
  next = replaceOnce(
    next,
    "        for (const layoutLine of visibleLines) {\n            let displayText = layoutLine.text;",
    "        let mouseVisualIndex = 0;\n        for (const layoutLine of visibleLines) {\n            let displayText = layoutLine.text;",
    "selection render index",
  );
  next = replaceOnce(
    next,
    "            }\n            // Calculate padding based on actual visible width\n            const padding = \" \".repeat(Math.max(0, contentWidth - lineVisibleWidth));",
    "            }\n            displayText = this.applyMouseSelectionHighlight(displayText, mouseVisualIndex++);\n            // Calculate padding based on actual visible width\n            const padding = \" \".repeat(Math.max(0, contentWidth - lineVisibleWidth));",
    "selection render",
  );
  next = replaceOnce(
    next,
    "    handleInput(data) {\n        const kb = getKeybindings();",
    "    handleInput(data) {\n        const kb = getKeybindings();\n        if (this.consumeMouseSelectionInput(data, kb)) return;",
    "editor input",
  );
  next = replaceOnce(
    next,
    "    setText(text) {\n        this.cancelAutocomplete();",
    "    setText(text) {\n        this.clearMouseSelection();\n        this.cancelAutocomplete();",
    "setText clear",
  );
  next = replaceOnce(
    next,
    "    handlePaste(pastedText) {\n        this.cancelAutocomplete();\n        this.exitHistoryBrowsing();\n        this.lastAction = null;\n        this.pushUndoSnapshot();",
    "    handlePaste(pastedText) {\n        this.cancelAutocomplete();\n        this.exitHistoryBrowsing();\n        this.lastAction = null;\n        if (!this.deleteMouseSelection(false)) this.pushUndoSnapshot();",
    "paste replace",
  );
  next = replaceOnce(
    next,
    "    addNewLine() {\n        this.cancelAutocomplete();\n        this.exitHistoryBrowsing();\n        this.lastAction = null;\n        this.pushUndoSnapshot();",
    "    addNewLine() {\n        this.cancelAutocomplete();\n        this.exitHistoryBrowsing();\n        this.lastAction = null;\n        if (!this.deleteMouseSelection(false)) this.pushUndoSnapshot();",
    "newline replace",
  );
  next = replaceOnce(
    next,
    "    submitValue() {\n        this.cancelAutocomplete();",
    "    submitValue() {\n        this.clearMouseSelection();\n        this.cancelAutocomplete();",
    "submit clear",
  );
  next = replaceOnce(
    next,
    "    layoutText(contentWidth) {",
    `    handleMouse(event) {\n        const position = this.getMousePosition(event.x, event.y);\n        if (!position) return false;\n        if (event.kind === "press") {\n            this.cancelAutocomplete();\n            this.exitHistoryBrowsing();\n            this.mouseSelectionAnchor = position;\n            this.mouseSelectionFocus = position;\n            this.mouseSelectionActive = true;\n        } else if (event.kind === "drag") {\n            if (!this.mouseSelectionActive) return false;\n            this.mouseSelectionFocus = position;\n        } else {\n            if (!this.mouseSelectionActive) return false;\n            this.mouseSelectionFocus = position;\n            this.mouseSelectionActive = false;\n        }\n        this.state.cursorLine = position.line;\n        this.setCursorCol(position.col);\n        this.tui.requestRender();\n        return true;\n    }\n    getMousePosition(x, y) {\n        const visualLines = this.buildVisualLineMap(this.lastWidth);\n        if (visualLines.length === 0) return undefined;\n        const visualIndex = Math.max(0, Math.min(visualLines.length - 1, this.lastRenderedTop + y - 1));\n        const visualLine = visualLines[visualIndex];\n        if (!visualLine) return undefined;\n        const text = (this.state.lines[visualLine.logicalLine] || "").slice(visualLine.startCol, visualLine.startCol + visualLine.length);\n        const promptRow = Number.isFinite(this.promptPaddingX) && this.lastRenderedTop === 0 && visualIndex === 0;\n        const targetWidth = Math.max(0, x - (promptRow ? 2 : this.paddingX));\n        let col = visualLine.startCol;\n        let width = 0;\n        for (const segment of this.segment(text, "grapheme")) {\n            const segmentWidth = visibleWidth(segment.segment);\n            if (width + segmentWidth > targetWidth) break;\n            width += segmentWidth;\n            col = visualLine.startCol + segment.index + segment.segment.length;\n        }\n        return { line: visualLine.logicalLine, col: Math.min(col, visualLine.startCol + visualLine.length) };\n    }\n    getMouseSelection() {\n        const anchor = this.mouseSelectionAnchor;\n        const focus = this.mouseSelectionFocus;\n        if (!anchor || !focus || (anchor.line === focus.line && anchor.col === focus.col)) return undefined;\n        return anchor.line < focus.line || (anchor.line === focus.line && anchor.col < focus.col) ? { start: anchor, end: focus } : { start: focus, end: anchor };\n    }\n    clearMouseSelection() {\n        this.mouseSelectionAnchor = this.mouseSelectionFocus = null;\n        this.mouseSelectionActive = false;\n    }\n    deleteMouseSelection(notify = true) {\n        const selection = this.getMouseSelection();\n        if (!selection) return false;\n        this.pushUndoSnapshot();\n        const before = (this.state.lines[selection.start.line] || "").slice(0, selection.start.col);\n        const after = (this.state.lines[selection.end.line] || "").slice(selection.end.col);\n        this.state.lines.splice(selection.start.line, selection.end.line - selection.start.line + 1, before + after);\n        this.state.cursorLine = selection.start.line;\n        this.setCursorCol(selection.start.col);\n        this.clearMouseSelection();\n        if (notify) this.onChange?.(this.getText());\n        return true;\n    }\n    applyMouseSelectionHighlight(text, visualIndex) {\n        const selection = this.getMouseSelection();\n        if (!selection) return text;\n        const visualLine = this.buildVisualLineMap(this.lastWidth)[this.lastRenderedTop + visualIndex];\n        if (!visualLine || visualLine.logicalLine < selection.start.line || visualLine.logicalLine > selection.end.line) return text;\n        const lineStart = visualLine.startCol;\n        const lineEnd = visualLine.startCol + visualLine.length;\n        const from = visualLine.logicalLine === selection.start.line ? Math.max(lineStart, selection.start.col) : lineStart;\n        const to = visualLine.logicalLine === selection.end.line ? Math.min(lineEnd, selection.end.col) : lineEnd;\n        const localFrom = from - lineStart;\n        const localTo = to - lineStart;\n        if (localFrom >= localTo) return text;\n        const raw = (this.state.lines[visualLine.logicalLine] || "").slice(lineStart, lineEnd);\n        const fromCol = visibleWidth(raw.slice(0, localFrom));\n        const toCol = visibleWidth(raw.slice(0, localTo));\n        const before = sliceByColumn(text, 0, fromCol, true);\n        const selected = sliceByColumn(text, fromCol, toCol - fromCol, true);\n        const after = sliceByColumn(text, toCol, Math.max(0, visibleWidth(text) - toCol), true);\n        return before + "\\x1b[7m" + selected + "\\x1b[27m" + after + "\\x1b[0m";\n    }\n    consumeMouseSelectionInput(data, kb) {\n        if (!this.getMouseSelection()) return false;\n        if (kb.matches(data, "tui.editor.deleteCharBackward") || kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete") || kb.matches(data, "tui.editor.deleteWordBackward") || kb.matches(data, "tui.editor.deleteWordForward") || kb.matches(data, "tui.editor.deleteToLineStart") || kb.matches(data, "tui.editor.deleteToLineEnd")) {\n            this.deleteMouseSelection();\n            return true;\n        }\n        if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.editor.cursorUp") || kb.matches(data, "tui.editor.cursorDown") || kb.matches(data, "tui.editor.cursorLineStart") || kb.matches(data, "tui.editor.cursorLineEnd") || kb.matches(data, "tui.editor.cursorWordLeft") || kb.matches(data, "tui.editor.cursorWordRight") || kb.matches(data, "tui.editor.historyPrevious") || kb.matches(data, "tui.editor.historyNext") || kb.matches(data, "tui.editor.pageUp") || kb.matches(data, "tui.editor.pageDown")) {\n            this.clearMouseSelection();\n            return false;\n        }\n        if (kb.matches(data, "tui.input.submit")) {\n            this.clearMouseSelection();\n            return false;\n        }\n        const mouseReplacement = decodePrintableKey(data);\n        if (mouseReplacement !== undefined || (data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127 && !data.startsWith("\\x1b"))) {\n            this.deleteMouseSelection(false);\n            this.insertCharacter(mouseReplacement ?? data, true);\n            return true;\n        }\n        return false;\n    }\n    layoutText(contentWidth) {`,
    "editor mouse methods",
  );
  return next;
}

export function injectEditorMouseRouting(source) {
  if (source.includes(TUI_MARKER)) return source;
  let next = replaceOnce(
    source,
    "            if (!handled)\n                this.handleSelectionMouseEvent(mouseEvent);",
    "            if (!handled && !this.routeFocusedMouseEvent(mouseEvent))\n                this.handleSelectionMouseEvent(mouseEvent);",
    "mouse routing call",
  );
  next = replaceOnce(
    next,
    "    handleRightClickPaste(event) {",
    `    // ${TUI_MARKER}\n    findFocusedMouseBox(component) {\n        // Interactive mode wraps the editor in a Container that renders its child itself\n        // (editorContainer.clear() then addChild(this.editor)), so the layout\n        // tree ends at the container and the editor is never a layout node. Claim the\n        // container's box only for that exact shape: a layout leaf holding the focused\n        // component as its single child. A lone child starts at the container's first row,\n        // so the box origin is the component's origin. Anything wider (siblings, padding\n        // boxes) would shift the coordinates handleMouse is about to be handed.\n        const wraps = (node) => {\n            if (!node.component || node.children?.length) return false;\n            const nested = node.component.children;\n            return Array.isArray(nested) && nested.length === 1 && nested[0] === component;\n        };\n        const visit = (node) => {\n            if (!node) return undefined;\n            if (node.component === component) return node;\n            for (const child of node.children ?? []) {\n                const found = visit(child);\n                if (found) return found;\n            }\n            if (wraps(node)) return node;\n            return undefined;\n        };\n        return visit(this.currentLayout?.root);\n    }\n    routeFocusedMouseEvent(event) {\n        const focused = this.getFocusedComponent();\n        if (!focused?.handleMouse) return false;\n        const button = event.button & 3;\n        const drag = (event.button & 32) !== 0;\n        if (button !== 0 && !(drag && button === 3) && !(event.release && button === 3)) return false;\n        const kind = event.release ? "release" : drag ? "drag" : "press";\n        const box = this.findFocusedMouseBox(focused);\n        if (!box) return false;\n        const bounds = box.clip ?? box.rect;\n        const inside = event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height;\n        if (!inside && !(focused.mouseSelectionActive && kind !== "press")) return false;\n        return focused.handleMouse({ kind, x: event.x - box.rect.x, y: event.y - box.rect.y }) === true;\n    }\n    handleRightClickPaste(event) {`,
    "mouse routing method",
  );
  return next;
}
