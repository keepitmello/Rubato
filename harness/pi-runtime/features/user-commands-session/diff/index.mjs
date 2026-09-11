import { Container, DynamicBorder, Key, SelectList, Text, matchesKey } from "../tui.mjs";
import { isEditorLaunch, openWithCode } from "../open-in-editor.mjs";

function parseGitStatus(stdout) {
  const files = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const file = line.slice(2).trimStart();
    let statusLabel;
    if (status.includes("M")) statusLabel = "M";
    else if (status.includes("A")) statusLabel = "A";
    else if (status.includes("D")) statusLabel = "D";
    else if (status.includes("?")) statusLabel = "?";
    else if (status.includes("R")) statusLabel = "R";
    else if (status.includes("C")) statusLabel = "C";
    else statusLabel = status.trim() || "~";
    files.push({ status: statusLabel, statusLabel, file });
  }
  return files;
}

function statusColor(theme, status) {
  switch (status) {
    case "M": return theme.fg("warning", status);
    case "A": return theme.fg("success", status);
    case "D": return theme.fg("error", status);
    case "?": return theme.fg("muted", status);
    default: return theme.fg("dim", status);
  }
}

export function createDiffExtension({ exec } = {}) {
  return (pi) => {
    const run = (command, args, options) => (exec ? exec(command, args, options, pi) : pi.exec(command, args, options));
    pi.registerCommand("diff", {
      description: "Show git changes and open in VS Code diff view",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("No UI available", "error");
          return;
        }
        const result = await run("git", ["status", "--porcelain"], { cwd: ctx.cwd });
        if (result.code !== 0) {
          ctx.ui.notify("git status failed: " + result.stderr, "error");
          return;
        }
        if (!result.stdout?.trim()) {
          ctx.ui.notify("No changes in working tree", "info");
          return;
        }
        const files = parseGitStatus(result.stdout);
        if (files.length === 0) {
          ctx.ui.notify("No changes found", "info");
          return;
        }

        const openSelected = async (fileInfo) => {
          try {
            if (fileInfo.status === "?") {
              const openResult = await openWithCode({ exec: run, cwd: ctx.cwd, path: fileInfo.file, notify: ctx.ui.notify });
              if (!openResult) return;
              if (openResult.code !== 0) {
                const openStderr = openResult.stderr.trim();
                ctx.ui.notify("Failed to open " + fileInfo.file + " (exit " + openResult.code + ")" + (openStderr ? ": " + openStderr : ""), "error");
              }
              return;
            }
            const diffResult = await run("git", ["difftool", "-y", "--tool=vscode", fileInfo.file], { cwd: ctx.cwd });
            if (diffResult.code !== 0) {
              const diffStderr = diffResult.stderr.trim();
              ctx.ui.notify("Failed to show diff with vscode for " + fileInfo.file + " (exit " + diffResult.code + ")" + (diffStderr ? ": " + diffStderr : ""), "error");
              ctx.ui.notify("Troubleshooting: check git difftool config (e.g. `git config --get difftool.vscode.cmd`).", "info");
              const openResult = await openWithCode({ exec: run, cwd: ctx.cwd, path: fileInfo.file, notify: ctx.ui.notify });
              if (!openResult) return;
              if (openResult.code !== 0) {
                const openStderr = openResult.stderr.trim();
                ctx.ui.notify("Failed to open " + fileInfo.file + " (exit " + openResult.code + ")" + (openStderr ? ": " + openStderr : ""), "error");
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify("Failed to open " + fileInfo.file + ": " + message, "error");
          }
        };

        await ctx.ui.custom((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to diff")), 0, 0));
          const filesByValue = new Map();
          const items = files.map((fileInfo, i) => {
            const key = String(i);
            filesByValue.set(key, fileInfo);
            return { value: key, label: statusColor(theme, fileInfo.status) + " " + fileInfo.file };
          });
          const visibleRows = Math.min(files.length, 15);
          let currentIndex = 0;
          const selectList = new SelectList(items, visibleRows, {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => t,
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          selectList.onSelect = (item) => {
            const fileInfo = filesByValue.get(item.value);
            if (fileInfo) void openSelected(fileInfo);
          };
          selectList.onCancel = () => done();
          selectList.onSelectionChange = (item) => {
            currentIndex = items.indexOf(item);
          };
          container.addChild(selectList);
          container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"), 0, 0));
          container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              if (matchesKey(data, Key.left)) {
                currentIndex = Math.max(0, currentIndex - visibleRows);
                selectList.setSelectedIndex(currentIndex);
              } else if (matchesKey(data, Key.right)) {
                currentIndex = Math.min(items.length - 1, currentIndex + visibleRows);
                selectList.setSelectedIndex(currentIndex);
              } else {
                selectList.handleInput(data);
              }
              tui.requestRender();
            },
          };
        });
      },
    });
  };
}

export { isEditorLaunch, parseGitStatus };
export default createDiffExtension;
