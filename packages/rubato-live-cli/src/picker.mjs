import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NEW_SESSION = "__rubato_new__";

export function pickerItems(sessions) {
  return [
    { value: NEW_SESSION, label: "New session", description: "Start Rubato in this directory" },
    ...sessions.map((session) => ({
      value: session.liveSessionId,
      label: session.title,
      description: [session.model?.label, session.cwd, session.lifecycle].filter(Boolean).join(" · "),
    })),
  ];
}

export function createPickerScreen(sessions, {
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
}, finish, requestRender = () => {}) {
  const sessionItems = pickerItems(sessions).slice(1);
  const state = { activePane: "new" };
  const plain = (text) => text;
  const inverse = (text) => `\x1b[7m${text}\x1b[27m`;
  const dim = (text) => `\x1b[2m${text}\x1b[22m`;
  const list = new SelectList(sessionItems, Math.max(3, Math.min(12, sessions.length)), {
    selectedPrefix: plain,
    selectedText: (text) => state.activePane === "sessions" ? inverse(text) : text.replace(/^→ /, "  "),
    description: dim,
    scrollInfo: plain,
    noMatch: dim,
  });

  let geometry = { wide: true, newStart: 2, newEnd: 4, listStart: 3, rightStart: 31 };
  const fit = (text, width) => {
    const clipped = truncateToWidth(text, Math.max(1, width), "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  };
  const chooseSession = (index) => {
    if (index < 0 || index >= sessionItems.length) return false;
    list.setSelectedIndex(index);
    finish({ kind: "attach", liveSessionId: sessionItems[index].value });
    return true;
  };

  const screen = {
    get activePane() {
      return state.activePane;
    },
    get sessionList() {
      return list;
    },
    render(width) {
      const safeWidth = Math.max(20, width);
      const wide = safeWidth >= 72;
      const newLines = [
        state.activePane === "new" ? inverse(" New session ") : " New session",
        dim(" Start Rubato here"),
      ];
      const sessionHeader = state.activePane === "sessions"
        ? inverse(" Existing sessions ")
        : " Existing sessions";
      const heading = ["Rubato live sessions", ""];

      if (wide) {
        const leftWidth = Math.min(28, Math.max(20, Math.floor((safeWidth - 3) * 0.36)));
        const rightWidth = safeWidth - leftWidth - 3;
        const rightLines = [sessionHeader, ...list.render(rightWidth)];
        const height = Math.max(newLines.length, rightLines.length);
        geometry = { wide, newStart: 2, newEnd: 2 + newLines.length - 1, listStart: 3, rightStart: leftWidth + 3 };
        const rows = Array.from({ length: height }, (_, index) =>
          `${fit(newLines[index] ?? "", leftWidth)} │ ${fit(rightLines[index] ?? "", rightWidth)}`);
        const footerLines = state.activePane === "new"
          ? [
            "Enter start new  ·  → focus sessions, then ↑↓ choose + Enter open",
            "Click New session to start, or a session to open",
          ]
          : [
            "← focus New session  ·  ↑↓ choose  ·  Enter open",
            "Click New session to start, or a session to open",
          ];
        return [...heading, ...rows, "", ...footerLines.map((line) => dim(fit(line, safeWidth)))];
      }

      const rightLines = [sessionHeader, ...list.render(safeWidth)];
      const rightHeader = heading.length + newLines.length + 1;
      geometry = {
        wide,
        newStart: heading.length,
        newEnd: heading.length + newLines.length - 1,
        listStart: rightHeader + 1,
        rightStart: 0,
      };
      const footerLines = state.activePane === "new"
        ? [
          "Enter start new  ·  → focus sessions",
          "Then ↑↓ choose + Enter open",
          "Click New session to start,",
          "or a session to open",
        ]
        : [
          "← focus New session",
          "↑↓ choose  ·  Enter open",
          "Click New session to start,",
          "or a session to open",
        ];
      return [
        ...heading,
        ...newLines.map((line) => fit(line, safeWidth)),
        "",
        ...rightLines,
        "",
        ...footerLines.map((line) => dim(fit(line, safeWidth))),
      ];
    },
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        finish({ kind: "quit" });
        return;
      }
      if (state.activePane === "new") {
        if (matchesKey(data, "right") && sessionItems.length > 0) {
          state.activePane = "sessions";
          requestRender();
        } else if (matchesKey(data, "enter")) {
          finish({ kind: "new" });
        }
        return;
      }
      if (matchesKey(data, "left")) {
        state.activePane = "new";
        requestRender();
        return;
      }
      list.handleInput(data);
      requestRender();
    },
    handleMouse(event) {
      if (event.release || (event.button & 3) !== 0) return false;
      if (event.y >= geometry.newStart && event.y <= geometry.newEnd
        && (!geometry.wide || event.x < geometry.rightStart)) {
        state.activePane = "new";
        requestRender();
        finish({ kind: "new" });
        return true;
      }
      const inSessionPane = geometry.wide ? event.x >= geometry.rightStart : event.y >= geometry.listStart;
      if (!inSessionPane || event.y < geometry.listStart) return false;
      state.activePane = "sessions";
      requestRender();
      return chooseSession(event.y - geometry.listStart);
    },
  };
  list.onSelect = (item) => finish({ kind: "attach", liveSessionId: item.value });
  list.onCancel = () => finish({ kind: "quit" });
  return screen;
}

export async function pickLiveSession(sessions, { loadTui = loadPinnedPiTui } = {}) {
  const {
    ProcessTerminal,
    SelectList,
    TuiAltScreen,
    matchesKey,
    truncateToWidth,
    visibleWidth,
  } = await loadTui();
  const terminal = new ProcessTerminal();
  return new Promise((resolveSelection) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolveSelection(value);
    };
    let screen;
    class PickerTui extends TuiAltScreen {
      handleSelectionMouseEvent(event) {
        if (!screen?.handleMouse(event)) super.handleSelectionMouseEvent(event);
      }
    }
    const tui = new PickerTui(terminal, false, undefined, { mouse: true });
    screen = createPickerScreen(
      sessions,
      { SelectList, matchesKey, truncateToWidth, visibleWidth },
      finish,
      () => tui.requestRender(),
    );
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

export async function loadPinnedPiTui() {
  try {
    return await import("@earendil-works/pi-tui");
  } catch (directError) {
    try {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const senpiRoot = realpathSync(join(repositoryRoot, "node_modules", "@code-yeongyu", "senpi"));
      const nestedRequire = createRequire(join(senpiRoot, "package.json"));
      return await import(pathToFileURL(nestedRequire.resolve("@earendil-works/pi-tui")).href);
    } catch {
      throw directError;
    }
  }
}
