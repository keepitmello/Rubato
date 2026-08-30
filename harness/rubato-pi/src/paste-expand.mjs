const MARKER = "rubato.pasteExpand.injected";

const REMOVE_PASTE_MARKER = `    removePasteMarker(id) {
        const removal = this.pasteMarkers.remove(id, this.getText());
        if (!removal.removed)
            return false;
        this.state.lines = removal.text.split("\\n");
        return true;
    }`;

const REMOVE_PASTE_MARKER_WITH_EXPAND = `    removePasteMarker(id) {
        const removal = this.pasteMarkers.remove(id, this.getText());
        if (!removal.removed)
            return false;
        this.state.lines = removal.text.split("\\n");
        return true;
    }
    expandMatchingPaste(filteredText) {
        // ${MARKER}
        let text = this.getText();
        for (;;) {
            const orphanState = this.pasteMarkers.snapshot();
            let orphanId;
            for (const [id, marker] of orphanState.markers) {
                if (text.indexOf(marker) < 0 && (orphanId === undefined || id < orphanId))
                    orphanId = id;
            }
            if (orphanId === undefined)
                break;
            const orphanRemoval = this.pasteMarkers.remove(orphanId, text);
            if (!orphanRemoval.removed)
                break;
            text = orphanRemoval.text;
        }
        if (text !== this.getText())
            this.state.lines = text.split("\\n");
        const pasteState = this.pasteMarkers.snapshot();
        for (const [id, content] of pasteState.pastes) {
            if (content !== filteredText)
                continue;
            const marker = pasteState.markers.get(id);
            if (!marker)
                continue;
            const first = text.indexOf(marker);
            if (first < 0 || text.indexOf(marker, first + marker.length) >= 0)
                continue;
            const removal = this.pasteMarkers.remove(id, text);
            if (!removal.removed)
                continue;
            const expanded = removal.text.slice(0, first) + content + removal.text.slice(first);
            this.state.lines = expanded.split("\\n");
            const prefix = expanded.slice(0, first + content.length);
            const prefixLines = prefix.split("\\n");
            this.state.cursorLine = prefixLines.length - 1;
            this.setCursorCol(prefixLines[prefixLines.length - 1].length);
            if (this.onChange)
                this.onChange(this.getText());
            return true;
        }
        if (text !== this.getText() && this.onChange)
            this.onChange(this.getText());
        return false;
    }`;

const LARGE_PASTE_BRANCH = `        if (pastedLines.length > 10 || totalChars > 1000) {
            const marker = this.pasteMarkers.add(filteredText, pastedLines.length, totalChars);
            this.insertTextAtCursorInternal(marker);
            return;
        }`;

const LARGE_PASTE_WITH_EXPAND = `        if (pastedLines.length > 10 || totalChars > 1000) {
            if (this.expandMatchingPaste(filteredText))
                return;
            const marker = this.pasteMarkers.add(filteredText, pastedLines.length, totalChars);
            this.insertTextAtCursorInternal(marker);
            return;
        }`;

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato paste expand transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function isPasteExpandModuleUrl(url) {
  return url.includes("pi-tui/dist/components/editor.js");
}

export function injectPasteExpand(source) {
  if (source.includes(MARKER)) return source;
  let next = replaceOnce(source, REMOVE_PASTE_MARKER, REMOVE_PASTE_MARKER_WITH_EXPAND, "expand matching paste method");
  return replaceOnce(next, LARGE_PASTE_BRANCH, LARGE_PASTE_WITH_EXPAND, "large paste branch");
}
