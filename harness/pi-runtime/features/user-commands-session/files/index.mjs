import { Container, DynamicBorder, Key, SelectList, Text, matchesKey } from "../tui.mjs";
import { openWithCode } from "../open-in-editor.mjs";

const PATCH_PATH_RE = /^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm;

function stripHeredoc(input) {
  const match = input.match(/^(?:cat\s+)?<<['\"]?(\w+)['\"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? (match[2] ?? input) : input;
}

export function extractPatchedPaths(patchText) {
  const normalized = stripHeredoc(String(patchText).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const matches = normalized.matchAll(PATCH_PATH_RE);
  return Array.from(matches, (match) => match[1] ?? "");
}

export function collectSessionFiles(branch) {
  const toolCalls = new Map();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type !== "toolCall") continue;
        const name = block.name;
        if (name === "read" || name === "write" || name === "edit") {
          const path = block.arguments?.path;
          if (path && typeof path === "string") {
            toolCalls.set(block.id, { paths: [path], name, timestamp: msg.timestamp });
          }
        } else if (name === "apply_patch") {
          const input = block.arguments?.input;
          if (typeof input === "string") {
            const paths = extractPatchedPaths(input);
            if (paths.length > 0) toolCalls.set(block.id, { paths, name: "edit", timestamp: msg.timestamp });
          }
        }
      }
    }
  }
  const fileMap = new Map();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    const toolCall = toolCalls.get(msg.toolCallId);
    if (!toolCall) continue;
    const { paths, name } = toolCall;
    const timestamp = msg.timestamp;
    for (const path of paths) {
      const existing = fileMap.get(path);
      if (existing) {
        existing.operations.add(name);
        if (timestamp > existing.lastTimestamp) existing.lastTimestamp = timestamp;
      } else {
        fileMap.set(path, { path, operations: new Set([name]), lastTimestamp: timestamp });
      }
    }
  }
  return Array.from(fileMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

export function createFilesExtension({ exec } = {}) {
  return (pi) => {
    const run = (command, args, options) => (exec ? exec(command, args, options, pi) : pi.exec(command, args, options));
    pi.registerCommand("files", {
      description: "Show files read/written/edited in this session",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("No UI available", "error");
          return;
        }
        const files = collectSessionFiles(ctx.sessionManager.getBranch());
        if (files.length === 0) {
          ctx.ui.notify("No files read/written/edited in this session", "info");
          return;
        }
        const openSelected = async (file) => {
          try {
            const openResult = await openWithCode({ exec: run, cwd: ctx.cwd, path: file.path, notify: ctx.ui.notify });
            if (!openResult) return;
            if (openResult.code !== 0) {
              const openStderr = openResult.stderr.trim();
              ctx.ui.notify("Failed to open " + file.path + " (exit " + openResult.code + ")" + (openStderr ? ": " + openStderr : ""), "error");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify("Failed to open " + file.path + ": " + message, "error");
          }
        };
        await ctx.ui.custom((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to open")), 0, 0));
          const filesByValue = new Map();
          const items = files.map((file, i) => {
            const key = String(i);
            filesByValue.set(key, file);
            const ops = [];
            if (file.operations.has("read")) ops.push(theme.fg("muted", "R"));
            if (file.operations.has("write")) ops.push(theme.fg("success", "W"));
            if (file.operations.has("edit")) ops.push(theme.fg("warning", "E"));
            return { value: key, label: ops.join("") + " " + file.path };
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
            const fileEntry = filesByValue.get(item.value);
            if (fileEntry) void openSelected(fileEntry);
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

export default createFilesExtension;
