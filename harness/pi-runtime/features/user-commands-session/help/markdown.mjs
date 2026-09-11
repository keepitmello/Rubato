import { KEYBINDINGS } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { BUILTIN_SLASH_COMMANDS } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";

const KEYBINDING_GROUPS = [
  { prefix: "tui.editor.", heading: "Editor" },
  { prefix: "tui.input.", heading: "Input" },
  { prefix: "tui.select.", heading: "Selection" },
  { prefix: "tui.altScreen.", heading: "Alt Screen" },
  { prefix: "app.", heading: "Application" },
];

function escapeTableCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatKeys(keybindings, id) {
  const keys = keybindings?.getKeys?.(id) ?? [];
  if (keys.length === 0) return "";
  return keys
    .join("/")
    .split("/")
    .map((key) => key
      .split("+")
      .map((part) => {
        const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
        return display.charAt(0).toUpperCase() + display.slice(1);
      })
      .join("+"))
    .join("/");
}

function buildGettingStarted(keybindings) {
  const submit = formatKeys(keybindings, "tui.input.submit") || "Enter";
  const newLine = formatKeys(keybindings, "tui.input.newLine") || "Shift+Enter";
  const pasteImage = formatKeys(keybindings, "app.clipboard.pasteImage") || "Ctrl+V";
  const followUp = formatKeys(keybindings, "app.message.followUp") || "Ctrl+U";
  return [
    "- Press `" + submit + "` to submit; use `" + newLine + "` to add a new line.",
    "- Type `!` to run bash, or `!!` to run bash without adding the command or output to context.",
    "- Type `/` for commands.",
    "- Drop files into the terminal to attach them.",
    "- Press `" + pasteImage + "` to paste an image, with text fallback.",
    "- Press `" + followUp + "` to queue a follow-up message.",
    "- Press `?` on an empty input to show the shortcut overlay.",
  ].join("\n");
}

function buildKeybindingTables(keybindings) {
  const rowsByPrefix = new Map(KEYBINDING_GROUPS.map((group) => [group.prefix, []]));
  for (const [id, definition] of Object.entries(KEYBINDINGS)) {
    const group = KEYBINDING_GROUPS.find((candidate) => id.startsWith(candidate.prefix));
    if (!group) continue;
    const keys = formatKeys(keybindings, id);
    if (!keys) continue;
    const rows = rowsByPrefix.get(group.prefix);
    if (!rows) continue;
    rows.push("| `" + escapeTableCell(keys) + "` | " + escapeTableCell(definition.description ?? "") + " |");
  }
  return KEYBINDING_GROUPS.map((group) => {
    const rows = rowsByPrefix.get(group.prefix) ?? [];
    return ["### " + group.heading, "| Key | Action |", "|-----|--------|", ...rows].join("\n");
  }).join("\n\n");
}

export function buildHelpMarkdown({ extensionCommands = [], keybindings } = {}) {
  const commandsByName = new Map();
  for (const command of [...BUILTIN_SLASH_COMMANDS, ...extensionCommands]) {
    if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
  }
  const commandLines = [...commandsByName.values()].map((command) => {
    const description = command.description ?? "";
    return "/" + command.name + " — " + description;
  });
  return [
    "## Getting started",
    buildGettingStarted(keybindings),
    "## Keybindings",
    buildKeybindingTables(keybindings),
    "## Commands",
    commandLines.join("\n"),
  ].join("\n\n");
}
