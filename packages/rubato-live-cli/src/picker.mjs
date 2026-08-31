import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NEW_SESSION = "__rubato_new__";

export function pickerItems(sessions) {
  return [
    ...sessions.map((session) => ({
      value: session.liveSessionId,
      label: session.title,
      description: [session.model?.label, session.cwd, session.lifecycle].filter(Boolean).join(" · "),
    })),
    { value: NEW_SESSION, label: "New session", description: "Start Rubato in this directory" },
  ];
}

export async function pickLiveSession(sessions, { loadTui = loadPinnedPiTui } = {}) {
  const { Container, ProcessTerminal, SelectList, Text, TuiAltScreen } = await loadTui();
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const root = new Container();
  root.addChild(new Text("Rubato live sessions\n", 0, 0));
  const plain = (text) => text;
  const list = new SelectList(pickerItems(sessions), Math.max(3, Math.min(12, sessions.length + 1)), {
    selectedPrefix: plain,
    selectedText: (text) => `\x1b[7m${text}\x1b[27m`,
    description: (text) => `\x1b[2m${text}\x1b[22m`,
    scrollInfo: plain,
    noMatch: plain,
  });
  root.addChild(list);
  tui.addChild(root);
  tui.setFocus(list);
  return new Promise((resolveSelection) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolveSelection(value);
    };
    list.onSelect = (item) => finish(item.value === NEW_SESSION ? { kind: "new" } : { kind: "attach", liveSessionId: item.value });
    list.onCancel = () => finish({ kind: "quit" });
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
