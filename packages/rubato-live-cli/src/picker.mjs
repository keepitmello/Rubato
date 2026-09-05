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

export function renderPickerStars(lines, { width, height, left, top, panelWidth, panelHeight, time }) {
  const color = process.env.NO_COLOR === undefined;
  const background = (y, from, to) => {
    let line = "";
    for (let x = from; x < to; x++) {
      const hash = (Math.imul(x + 11, 73856093) ^ Math.imul(y + 7, 19349663)) >>> 0;
      if (hash % 137 !== 0) { line += " "; continue; }
      const glow = .5 + .5 * Math.sin(time / 1150 + hash % 628 / 100);
      if (glow < .23) { line += " "; continue; }
      const glyph = glow > .96 && hash % 3 === 0 ? "✦" : glow > .65 ? "·" : "⠂";
      line += color ? `\x1b[38;5;${glow > .8 ? 103 : 60}m${glyph}\x1b[0m` : glyph;
    }
    return line;
  };
  return Array.from({ length: height }, (_, y) =>
    y >= top && y < top + panelHeight
      ? background(y, 0, left) + lines[y] + background(y, left + panelWidth, width)
      : background(y, 0, width));
}

export function createPickerScreen(sessions, {
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
}, finish, requestRender = () => {}, getRows = () => process.stdout.rows ?? 24) {
  const sessionItems = pickerItems(sessions).slice(1);
  const state = { activePane: "new" };
  let animationTimer = null;
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
    invalidate() {},
    startAnimation() {
      if (!animationTimer) animationTimer = setInterval(requestRender, 120);
      animationTimer.unref?.();
    },
    dispose() {
      if (animationTimer) clearInterval(animationTimer);
      animationTimer = null;
    },
    render(width) {
      const outerWidth = Math.max(1, width - 1);
      const viewportRows = Math.max(1, getRows() - 1);
      const safeWidth = Math.max(1, Math.min(86, outerWidth - 4));
      const wide = safeWidth >= 72;
      list.maxVisible = Math.max(1, Math.min(12, sessions.length, viewportRows - (wide ? 10 : 15)));
      const place = (content) => {
        const left = Math.max(0, Math.floor((outerWidth - safeWidth) / 2));
        const top = Math.max(0, Math.min(viewportRows - content.length, Math.round(viewportRows * .45 - content.length / 2)));
        const scrollStart = Math.max(0, Math.min(
          list.selectedIndex - Math.floor(list.maxVisible / 2),
          sessionItems.length - list.maxVisible,
        ));
        geometry = { ...geometry, left, top, width: safeWidth, height: Math.min(content.length, viewportRows), scrollStart };
        const panel = [
          ...Array(top).fill(""),
          ...content.slice(0, viewportRows - top).map((line) => fit(line, safeWidth)),
        ];
        return renderPickerStars(panel, {
          width: outerWidth, height: viewportRows, left, top, panelWidth: safeWidth,
          panelHeight: geometry.height, time: Date.now(),
        });
      };
      const newLines = [
        state.activePane === "new" ? inverse(" New session ") : " New session",
        dim(" Start Rubato here"),
      ];
      const sessionHeader = state.activePane === "sessions"
        ? inverse(" Existing sessions ")
        : " Existing sessions";
      const centerHeading = (text) =>
        " ".repeat(Math.max(0, Math.floor((safeWidth - visibleWidth(text)) / 2))) + text;
      const heading = [centerHeading("𝒓𝒖𝒃𝒂𝒕𝒐"), dim(centerHeading("세션 선택")), ""];

      if (viewportRows < 16 || safeWidth < 20) {
        list.maxVisible = Math.max(1, Math.min(12, viewportRows - 6));
        geometry = { wide: false, newStart: 1, newEnd: 1, listStart: 3, rightStart: 0 };
        return place([
          heading[0], newLines[0], sessionHeader,
          ...list.render(Math.max(5, safeWidth)),
          dim("Enter 선택 · ←→ 전환"),
        ]);
      }

      if (wide) {
        const leftWidth = Math.min(28, Math.max(20, Math.floor((safeWidth - 3) * 0.36)));
        const rightWidth = safeWidth - leftWidth - 3;
        const rightLines = [sessionHeader, ...list.render(rightWidth)];
        const height = Math.max(newLines.length, rightLines.length);
        geometry = { wide, newStart: heading.length, newEnd: heading.length + newLines.length - 1, listStart: heading.length + 1, rightStart: leftWidth + 3 };
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
        return place([...heading, ...rows, "", ...footerLines.map((line) => dim(fit(line, safeWidth)))]);
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
      return place([
        ...heading,
        ...newLines.map((line) => fit(line, safeWidth)),
        "",
        ...rightLines,
        "",
        ...footerLines.map((line) => dim(fit(line, safeWidth))),
      ]);
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
      event = { ...event, x: event.x - (geometry.left ?? 0), y: event.y - (geometry.top ?? 0) };
      if (event.x < 0 || event.x >= geometry.width || event.y < 0 || event.y >= geometry.height) return false;
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
      const visibleIndex = event.y - geometry.listStart;
      if (visibleIndex >= list.maxVisible) return false;
      return chooseSession(visibleIndex + (geometry.scrollStart ?? 0));
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
      screen?.dispose();
      // zmx attach takes this terminal next. Dumping the picker into the
      // scrollback leaves mouse/alt-screen residue that kills the first turn.
      tui.stop({ preserveScreen: true });
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
      () => terminal.rows,
    );
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
    if (!settled) screen.startAnimation();
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
