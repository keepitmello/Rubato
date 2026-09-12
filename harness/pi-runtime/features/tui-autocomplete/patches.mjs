import { fileURLToPath } from "node:url";

const TUI_PACKAGE = "@earendil-works/pi-tui";
const VERSION = "0.85.1";
const INLINE_IMPORT = 'import { getDollarInvocationContext, getDollarInvocationSuggestions, getInlineSkillSuggestions, inlineSlashTokenAt, isInlineDollarToken } from "./rubato-features/tui-autocomplete/inline.mjs";';
const EDITOR_INLINE_IMPORT = 'import { inlineSlashTokenAt, isInlineDollarToken } from "../rubato-features/tui-autocomplete/inline.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[tui-autocomplete:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[tui-autocomplete:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[tui-autocomplete:" + label + "] expected pristine feature seam");
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: TUI_PACKAGE, version: VERSION, path, preimageSha256, apply });
}

const AC_IMPORT_BEFORE = 'import { fuzzyFilter } from "./fuzzy.js";\nconst PATH_DELIMITERS';
const AC_IMPORT_AFTER = 'import { fuzzyFilter } from "./fuzzy.js";\n' + INLINE_IMPORT + '\nconst PATH_DELIMITERS';

const AC_LEADING_BEFORE = '        if (!options.force && textBeforeCursor.startsWith("/")) {\n            const spaceIndex = textBeforeCursor.indexOf(" ");\n            if (spaceIndex === -1) {\n                const prefix = textBeforeCursor.slice(1);';
const AC_LEADING_AFTER = '        const dollarContext = getDollarInvocationContext(textBeforeCursor, cursorLine, this.commands);\n        if (dollarContext) {\n            const suggestions = getDollarInvocationSuggestions(this.commands, dollarContext.query, dollarContext.skillsOnly, fuzzyFilter);\n            if (suggestions.length === 0)\n                return null;\n            return {\n                items: suggestions,\n                prefix: dollarContext.prefix,\n            };\n        }\n        if (!options.force && cursorLine === 0 && textBeforeCursor.startsWith("/")) {\n            const spaceIndex = textBeforeCursor.indexOf(" ");\n            if (spaceIndex === -1) {\n                if (textBeforeCursor.slice(1).includes("/"))\n                    return null;\n                const prefix = textBeforeCursor.slice(1);';

const AC_INLINE_BEFORE = '            return {\n                items: argumentSuggestions,\n                prefix: argumentText,\n            };\n        }\n        const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);';
const AC_INLINE_AFTER = '            return {\n                items: argumentSuggestions,\n                prefix: argumentText,\n            };\n        }\n        if (!options.force) {\n            const inlineToken = inlineSlashTokenAt(textBeforeCursor);\n            if (inlineToken) {\n                const filtered = getInlineSkillSuggestions(this.commands, inlineToken.slice(1), fuzzyFilter);\n                if (filtered.length > 0)\n                    return { items: filtered, prefix: inlineToken };\n            }\n        }\n        const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);';

const AC_APPLY_BEFORE = '        const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");';
const AC_APPLY_AFTER = '        if (prefix.startsWith("$") && (item.value.startsWith("/") || item.value.startsWith("$"))) {\n            const newLine = `${beforePrefix}${item.value} ${adjustedAfterCursor}`;\n            const newLines = [...lines];\n            newLines[cursorLine] = newLine;\n            return {\n                lines: newLines,\n                cursorLine,\n                cursorCol: beforePrefix.length + item.value.length + 1,\n            };\n        }\n        const isSlashCommand = prefix.startsWith("/") &&\n            !prefix.slice(1).includes("/") &&\n            (beforePrefix.trim() === "" || /\\s$/.test(beforePrefix));';

const ED_IMPORT_BEFORE = 'import { SelectList } from "./select-list.js";\nconst graphemeSegmenter';
const ED_IMPORT_AFTER = 'import { SelectList } from "./select-list.js";\n' + EDITOR_INLINE_IMPORT + '\nconst graphemeSegmenter';

const ED_TRIGGER_BEFORE = '            // Auto-trigger for "/" at the start of a line (slash commands)\n            if (char === "/" && this.isAtStartOfMessage()) {\n                this.tryTriggerAutocomplete();\n            }\n            // Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries';
const ED_TRIGGER_AFTER = '            // Auto-trigger for slash commands and inline skill invocations.\n            if (char === "/" && (this.isAtStartOfMessage() || this.isInlineSlash())) {\n                this.tryTriggerAutocomplete();\n            }\n            else if (char === "$" && this.isInlineDollar()) {\n                this.tryTriggerAutocomplete();\n            }\n            // Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries';

const ED_MENU_BEFORE = '    // Slash menu only allowed on the first line of the editor\n    isSlashMenuAllowed() {\n        return this.state.cursorLine === 0;\n    }\n    // Helper method to check if cursor is at start of message (for slash command detection)\n    isAtStartOfMessage() {\n        if (!this.isSlashMenuAllowed())\n            return false;\n        const currentLine = this.state.lines[this.state.cursorLine] || "";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return beforeCursor.trim() === "" || beforeCursor.trim() === "/";\n    }\n    isInSlashCommandContext(textBeforeCursor) {\n        return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");\n    }';
const ED_MENU_AFTER = '    isSlashMenuAllowed() {\n        return true;\n    }\n    // Helper method to check if cursor is at start of message (for slash command detection)\n    isAtStartOfMessage() {\n        if (!this.isSlashMenuAllowed())\n            return false;\n        const currentLine = this.state.lines[this.state.cursorLine] || "";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return beforeCursor.trim() === "" || beforeCursor.trim() === "/";\n    }\n    isInlineSlash() {\n        const currentLine = this.state.lines[this.state.cursorLine] || "";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return inlineSlashTokenAt(beforeCursor) !== null;\n    }\n    isInlineDollar() {\n        const currentLine = this.state.lines[this.state.cursorLine] || "";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return isInlineDollarToken(beforeCursor);\n    }\n    isInSlashCommandContext(textBeforeCursor) {\n        return inlineSlashTokenAt(textBeforeCursor) !== null ||\n            (this.state.cursorLine === 0 && textBeforeCursor.trimStart().startsWith("/"));\n    }';

export function patchTuiAutocomplete(source) {
  unpatched(source, INLINE_IMPORT, "autocomplete-import");
  let next = replaceOnce(source, AC_IMPORT_BEFORE, AC_IMPORT_AFTER, "autocomplete-import");
  next = replaceOnce(next, AC_LEADING_BEFORE, AC_LEADING_AFTER, "autocomplete-leading-slash");
  next = replaceOnce(next, AC_INLINE_BEFORE, AC_INLINE_AFTER, "autocomplete-inline-skill");
  return replaceOnce(next, AC_APPLY_BEFORE, AC_APPLY_AFTER, "autocomplete-apply");
}

export function patchTuiEditor(source) {
  unpatched(source, EDITOR_INLINE_IMPORT, "editor-import");
  let next = replaceOnce(source, ED_IMPORT_BEFORE, ED_IMPORT_AFTER, "editor-import");
  next = replaceOnce(next, ED_TRIGGER_BEFORE, ED_TRIGGER_AFTER, "editor-trigger");
  return replaceOnce(next, ED_MENU_BEFORE, ED_MENU_AFTER, "editor-slash-helpers");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: TUI_PACKAGE,
    version: VERSION,
    path: "dist/rubato-features/tui-autocomplete/inline.mjs",
    sourcePath: fileURLToPath(new URL("./inline.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("tui-autocomplete:provider", "dist/autocomplete.js", "c616bdb2993cc0e8caf8bf6f32927a10d9226755de3afe8efd8b51e97f3ef2bd", patchTuiAutocomplete),
  patch("tui-autocomplete:editor", "dist/components/editor.js", "9c0d4a853d30a77040319e245d474e02afebebde960161d3bc27b6081620db27", patchTuiEditor),
]);

export const feature = Object.freeze({ id: "tui-autocomplete", patches, files });
export default feature;
