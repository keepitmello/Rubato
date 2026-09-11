const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

export function quoteCmdArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Open a path with VS Code. Tests inject `exec` so a real editor is never launched. */
export async function openWithCode({ exec, cwd, path, notify }) {
  if (process.platform === "win32") {
    if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(path)) {
      notify(`Refusing to open ${path}: path contains Windows cmd metacharacters (& | < > ^ % or newline).`, "error");
      return null;
    }
    return exec("cmd", ["/d", "/s", "/c", `code -g ${quoteCmdArg(path)}`], { cwd });
  }
  return exec("code", ["-g", path], { cwd });
}

export function isEditorLaunch(command, args = []) {
  if (command === "code") return true;
  if (command === "cmd") return true;
  if (command === "git" && args[0] === "difftool") return true;
  return false;
}
