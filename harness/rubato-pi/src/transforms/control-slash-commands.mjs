import { replaceOnce } from "./replace-once.mjs";

export function isSlashCommandsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/slash-commands.js");
}

const REMOTE_MODES = [
  ['    { name: "settings", description: "Open settings menu" },', '    { name: "settings", description: "Open settings menu" , remoteMode: "terminal-only" },'],
  ['    { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },', '    { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" , remoteMode: "native-action" },'],
  ['    { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },', '    { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" , remoteMode: "terminal-only" },'],
  ['    { name: "favorite-models", description: "Manage favorite models for Ctrl+P cycling" },', '    { name: "favorite-models", description: "Manage favorite models for Ctrl+P cycling" , remoteMode: "terminal-only" },'],
  ['    { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },', '    { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" , remoteMode: "terminal-only" },'],
  ['    { name: "import", description: "Import and resume a session from a JSONL file" },', '    { name: "import", description: "Import and resume a session from a JSONL file" , remoteMode: "terminal-only" },'],
  ['    { name: "share", description: "Share session as a secret GitHub gist" },', '    { name: "share", description: "Share session as a secret GitHub gist" , remoteMode: "terminal-only" },'],
  ['    { name: "copy", description: "Copy last agent message to clipboard" },', '    { name: "copy", description: "Copy last agent message to clipboard" , remoteMode: "terminal-only" },'],
  ['    { name: "name", description: "Set session display name" },', '    { name: "name", description: "Set session display name" , remoteMode: "native-action" },'],
  ['    { name: "session", description: "Show session info and stats" },', '    { name: "session", description: "Show session info and stats" , remoteMode: "terminal-only" },'],
  ['    { name: "hotkeys", description: "Show all keyboard shortcuts" },', '    { name: "hotkeys", description: "Show all keyboard shortcuts" , remoteMode: "terminal-only" },'],
  ['    { name: "fork", description: "Create a new fork from a previous user message" },', '    { name: "fork", description: "Create a new fork from a previous user message" , remoteMode: "native-action" },'],
  ['    { name: "clone", description: "Duplicate the current session at the current position" },', '    { name: "clone", description: "Duplicate the current session at the current position" , remoteMode: "terminal-only" },'],
  ['    { name: "tree", description: "Navigate session tree (switch branches)" },', '    { name: "tree", description: "Navigate session tree (switch branches)" , remoteMode: "native-action" },'],
  ['    { name: "trust", description: "Save project trust decision for future sessions" },', '    { name: "trust", description: "Save project trust decision for future sessions" , remoteMode: "terminal-only" },'],
  ['    { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },', '    { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" , remoteMode: "terminal-only" },'],
  ['    { name: "logout", description: "Remove provider authentication" },', '    { name: "logout", description: "Remove provider authentication" , remoteMode: "terminal-only" },'],
  ['    { name: "new", description: "Start a new session" },', '    { name: "new", description: "Start a new session" , remoteMode: "native-action" },'],
  ['    { name: "compact", description: "Manually compact the session context" },', '    { name: "compact", description: "Manually compact the session context" , remoteMode: "native-action" },'],
  ['    { name: "resume", description: "Resume a different session" },', '    { name: "resume", description: "Resume a different session" , remoteMode: "terminal-only" },'],
  ['    { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },', '    { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" , remoteMode: "native-action" },'],
  ["    { name: \"quit\", description: `Quit ${APP_NAME}` },", "    { name: \"quit\", description: `Quit ${APP_NAME}` , remoteMode: \"native-action\" },"],
  ["    { name: \"exit\", description: `Quit ${APP_NAME} (alias of /quit)` },", "    { name: \"exit\", description: `Quit ${APP_NAME} (alias of /quit)` , remoteMode: \"native-action\" },"],
];

/**
 * #29 remoteMode on builtin slash commands. Changelog stays in the array
 * (stripChangelog may already have removed it); the follow-up find() is a no-op then.
 */
export function injectSlashCommandsRemoteMode(source) {
  let next = source;
  for (const [needle, replacement] of REMOTE_MODES) {
    next = replaceOnce(next, needle, replacement, `slash remoteMode ${needle.slice(12, 40)}`);
  }
  next = replaceOnce(
    next,
    "];\n//# sourceMappingURL=slash-commands.js.map",
    `];
const changelogCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "changelog");
if (changelogCommand)
    changelogCommand.remoteMode = "terminal-only";
//# sourceMappingURL=slash-commands.js.map`,
    "slash changelog remoteMode find",
  );
  return next;
}
