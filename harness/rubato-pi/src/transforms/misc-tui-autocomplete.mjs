import { replaceOnce } from "./misc-replace.mjs";

const AC_EXPORT_NEEDLE = "import { getSlashCommandSuggestions } from \"./slash-command-autocomplete.js\";\nconst PATH_DELIMITERS";

const AC_EXPORT_REPLACEMENT = "import { getSlashCommandSuggestions } from \"./slash-command-autocomplete.js\";\nexport function inlineSlashTokenAt(textBeforeCursor) {\n    const match = textBeforeCursor.match(/(?:^|\\s)(\\/[^\\s/]*)$/);\n    return match?.[1] ?? null;\n}\n\nconst PATH_DELIMITERS";

const AC_LEADING_NEEDLE = "        if (!options.force && textBeforeCursor.startsWith(\"/\")) {\n            const spaceIndex = textBeforeCursor.indexOf(\" \");\n            if (spaceIndex === -1) {\n                const prefix = textBeforeCursor.slice(1);";

const AC_LEADING_REPLACEMENT = "        if (!options.force && cursorLine === 0 && textBeforeCursor.startsWith(\"/\")) {\n            const spaceIndex = textBeforeCursor.indexOf(\" \");\n            if (spaceIndex === -1) {\n                // `//`, `/a/b` 같은 경로 꼴은 커맨드가 아니다. 중간 토큰과 같은\n                // 기준을 맨 앞에도 적용해 같은 글자가 자리에 따라 다르게 굴지 않게 한다.\n                if (textBeforeCursor.slice(1).includes(\"/\"))\n                    return null;\n                const prefix = textBeforeCursor.slice(1);";

const AC_INLINE_NEEDLE = "            return {\n                items: argumentSuggestions,\n                prefix: argumentText,\n            };\n        }\n        const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);";

const AC_INLINE_REPLACEMENT = "            return {\n                items: argumentSuggestions,\n                prefix: argumentText,\n            };\n        }\n        if (!options.force) {\n            const inlineToken = inlineSlashTokenAt(textBeforeCursor);\n            if (inlineToken) {\n                const skillCommands = this.commands.filter((command) => {\n                    const name = \"name\" in command ? command.name : command.value;\n                    return name.startsWith(\"skill:\");\n                });\n                const query = inlineToken.slice(1);\n                const filtered = getSlashCommandSuggestions(skillCommands, query);\n                if (filtered.length > 0)\n                    return { items: filtered, prefix: inlineToken };\n            }\n        }\n\n        const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);";

const AC_APPLY_NEEDLE = "        const isSlashCommand = prefix.startsWith(\"/\") &&\n            !prefix.slice(1).includes(\"/\") &&\n            (beforePrefix.trim() === \"\" ||\n                (prefix.startsWith(\"/skill:\") && this.isLeadingKnownSkillCommandRun(beforePrefix)));";

const AC_APPLY_REPLACEMENT = "        const isSlashCommand = prefix.startsWith(\"/\") &&\n            !prefix.slice(1).includes(\"/\") &&\n            (beforePrefix.trim() === \"\" ||\n                /\\s$/.test(beforePrefix) ||\n                (prefix.startsWith(\"/skill:\") && this.isLeadingKnownSkillCommandRun(beforePrefix)));";

const ED_IMPORT_NEEDLE = "import { SelectList } from \"./select-list.js\";\nconst graphemeSegmenter";

const ED_IMPORT_REPLACEMENT = "import { SelectList } from \"./select-list.js\";\nimport { inlineSlashTokenAt } from \"../autocomplete.js\";\nconst graphemeSegmenter";

const ED_TRIGGER_NEEDLE = "            // Auto-trigger for \"/\" at the start of a line (slash commands)\n            if (char === \"/\" && this.isAtStartOfMessage()) {\n                this.tryTriggerAutocomplete();\n            }\n            // Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries";

const ED_TRIGGER_REPLACEMENT = "            // Auto-trigger for slash commands and inline skill invocations.\n            if (char === \"/\" && (this.isAtStartOfMessage() || this.isInlineSlash())) {\n                this.tryTriggerAutocomplete();\n            }\n            // Bare inline `$` opens the skill picker; ordinary `$HOME` closes it on the next character.\n            else if (char === \"$\" && this.isInlineDollar()) {\n                this.tryTriggerAutocomplete();\n            }\n            // Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries";

const ED_MENU_NEEDLE = "    // Slash menu only allowed on the first line of the editor\n    isSlashMenuAllowed() {\n        return this.state.cursorLine === 0;\n    }\n    // Helper method to check if cursor is at start of message (for slash command detection)\n    isAtStartOfMessage() {\n        if (!this.isSlashMenuAllowed())\n            return false;\n        const currentLine = this.state.lines[this.state.cursorLine] || \"\";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return beforeCursor.trim() === \"\" || beforeCursor.trim() === \"/\";\n    }\n    isInSlashCommandContext(textBeforeCursor) {\n        return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith(\"/\");\n    }";

const ED_MENU_REPLACEMENT = "    isSlashMenuAllowed() {\n        return true;\n    }\n    // Helper method to check if cursor is at start of message (for slash command detection)\n    isAtStartOfMessage() {\n        if (!this.isSlashMenuAllowed())\n            return false;\n        const currentLine = this.state.lines[this.state.cursorLine] || \"\";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return beforeCursor.trim() === \"\" || beforeCursor.trim() === \"/\";\n    }\n    isInlineSlash() {\n        const currentLine = this.state.lines[this.state.cursorLine] || \"\";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return inlineSlashTokenAt(beforeCursor) !== null;\n    }\n    isInlineDollar() {\n        const currentLine = this.state.lines[this.state.cursorLine] || \"\";\n        const beforeCursor = currentLine.slice(0, this.state.cursorCol);\n        return /(?:^|\\s)\\$[a-zA-Z0-9:_-]*$/.test(beforeCursor);\n    }\n    isInSlashCommandContext(textBeforeCursor) {\n        return inlineSlashTokenAt(textBeforeCursor) !== null ||\n            (this.state.cursorLine === 0 && textBeforeCursor.trimStart().startsWith(\"/\"));\n    }";

const DOLLAR_PATTERN_NEEDLE = "const LEADING_DOLLAR_RUN_PATTERN = /^((?:\\$[a-zA-Z][a-zA-Z0-9:_-]*\\s+)*)\\$([a-zA-Z0-9:_-]*)$/;\nfunction commandName(command) {";

const DOLLAR_PATTERN_REPLACEMENT = "const LEADING_DOLLAR_RUN_PATTERN = /^((?:\\$[a-zA-Z][a-zA-Z0-9:_-]*\\s+)*)\\$([a-zA-Z0-9:_-]*)$/;\n// 문장 중간의 `$` — 앞이 공백이면 연다. `$HOME` 같은 셸 변수와 섞이지 않도록\n// 중간에서는 스킬만 보여 준다(skillsOnly). 맨 앞 실행 규칙은 위 패턴이 그대로 맡는다.\nconst INLINE_DOLLAR_PATTERN = /(?:^|\\s)\\$([a-zA-Z0-9:_-]*)$/;\nfunction commandName(command) {";

const DOLLAR_CTX_NEEDLE = "export function getDollarInvocationContext(textBeforeCursor, cursorLine, commands) {\n    if (cursorLine !== 0)\n        return null;\n    const match = textBeforeCursor.match(LEADING_DOLLAR_RUN_PATTERN);\n    if (!match)\n        return null;\n";

const DOLLAR_CTX_REPLACEMENT = "export function getDollarInvocationContext(textBeforeCursor, cursorLine, commands) {\n    const match = cursorLine === 0 ? textBeforeCursor.match(LEADING_DOLLAR_RUN_PATTERN) : null;\n    if (!match) {\n        // 맨 앞 런이 아니면 문장 중간의 `$` 로 본다.\n        const inline = textBeforeCursor.match(INLINE_DOLLAR_PATTERN);\n        if (!inline)\n            return null;\n        const raw = inline[1];\n        const explicit = raw.startsWith(SKILL_COMMAND_PREFIX);\n        return {\n            prefix: `$${raw}`,\n            query: explicit ? raw.slice(SKILL_COMMAND_PREFIX.length) : raw,\n            skillsOnly: true,\n        };\n    }\n";

const SLASH_NEEDLE = "            (normalizedPrefix.length === 0 || !skillName.toLowerCase().startsWith(normalizedPrefix))) {";

const SLASH_REPLACEMENT = "            normalizedPrefix.length > 0 &&\n            !skillName.toLowerCase().startsWith(normalizedPrefix)) {";

export function isTuiAutocompleteUrl(url) {
  return url.includes("pi-tui/dist/autocomplete.js");
}

export function isTuiEditorUrl(url) {
  return url.includes("pi-tui/dist/components/editor.js");
}

export function isTuiDollarUrl(url) {
  return url.includes("pi-tui/dist/dollar-invocation-autocomplete.js");
}

export function isTuiSlashUrl(url) {
  return url.includes("pi-tui/dist/slash-command-autocomplete.js");
}

/**
 * Baseline senpi-tui autocomplete.js: inline /skill:, path-shaped leading /, first-line-only leading /.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectTuiAutocomplete(source) {
  let next = replaceOnce(source, AC_EXPORT_NEEDLE, AC_EXPORT_REPLACEMENT, "autocomplete inlineSlashTokenAt");
  next = replaceOnce(next, AC_LEADING_NEEDLE, AC_LEADING_REPLACEMENT, "autocomplete leading slash");
  next = replaceOnce(next, AC_INLINE_NEEDLE, AC_INLINE_REPLACEMENT, "autocomplete inline skill");
  return replaceOnce(next, AC_APPLY_NEEDLE, AC_APPLY_REPLACEMENT, "autocomplete applyCompletion");
}

/**
 * Baseline senpi-tui editor.js. Needles are chosen so they still exist after
 * editor-mouse + paste-expand (those transforms do not touch slash/import sites).
 *
 * @param {string} source
 * @returns {string}
 */
export function injectTuiEditor(source) {
  let next = replaceOnce(source, ED_IMPORT_NEEDLE, ED_IMPORT_REPLACEMENT, "editor inlineSlash import");
  next = replaceOnce(next, ED_TRIGGER_NEEDLE, ED_TRIGGER_REPLACEMENT, "editor slash/$ trigger");
  return replaceOnce(next, ED_MENU_NEEDLE, ED_MENU_REPLACEMENT, "editor slash helpers");
}

/**
 * Baseline senpi-tui dollar-invocation-autocomplete.js: mid-line `$skill`.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectTuiDollar(source) {
  let next = replaceOnce(source, DOLLAR_PATTERN_NEEDLE, DOLLAR_PATTERN_REPLACEMENT, "dollar inline pattern");
  return replaceOnce(next, DOLLAR_CTX_NEEDLE, DOLLAR_CTX_REPLACEMENT, "dollar context");
}

/**
 * Baseline senpi-tui slash-command-autocomplete.js: empty prefix still lists skills.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectTuiSlash(source) {
  return replaceOnce(source, SLASH_NEEDLE, SLASH_REPLACEMENT, "slash empty-prefix skills");
}
