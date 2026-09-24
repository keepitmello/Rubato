import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { RubatoUpdateState } from "@t3tools/contracts";

type Prompt = { type: "info" | "error"; title: string; message: string; detail: string; buttons: string[] };
type ElectronServices = Pick<typeof import("electron"), "ipcMain">;
type Update = { available: boolean; revision?: string; commits?: number };
type Result = { token: string; status: string; pid?: number; message?: string };
const exec = promisify(execFile);
const CHECK_INTERVAL = 4 * 60 * 60_000;
// Capture the one-shot handoff before T3 starts its backend. Update-only flags
// must not leak into model tools, terminals, or a future unrelated CLI update.
const restartToken = process.env.RUBATO_GUI_UPDATE_TOKEN;
for (const name of ["RUBATO_GUI_UPDATE", "RUBATO_GUI_UPDATE_TOKEN", "RUBATO_GUI_UPDATE_NODE", "RUBATO_GUI_UPDATE_RELAUNCH"]) {
  delete process.env[name];
}
const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
const directory = () => path.join(home(), ".rubato-pi", "gui-update");
const alive = (pid?: number) => {
  if (!pid || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function read<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}
async function write(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = await open(temporary, "w", 0o600);
  try { await fd.writeFile(JSON.stringify(value)); } finally { await fd.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

// Only fixed actions cross IPC; the renderer never supplies a path or command.
export function createRubatoUpdater(
  window: BrowserWindow,
  options: {
    stateDir: string;
    helper: string;
    message: (prompt: Prompt) => Promise<{ response: number }>;
    progress?: (value: number) => void;
    check?: () => Promise<Update>;
    launch?: (token: string) => Promise<void>;
    now?: () => number;
    watchMs?: number;
  },
) {
  const { stateDir, helper } = options;
  const now = options.now ?? Date.now;
  const resultPath = path.join(stateDir, "result.json");
  const seenPath = path.join(stateDir, "seen.json");
  const logPath = path.join(stateDir, "update.log");
  let busy = false;
  let stopped = false;
  let nextCheck = 0;
  let watcher: ReturnType<typeof setInterval> | undefined;
  let watching = false;
  let expectedToken: string | undefined;
  let launchDeadline = 0;
  const progress = (value: number) => {
    if (!window.isDestroyed()) window.setProgressBar(value);
    options.progress?.(value);
  };
  const message = options.message;
  const check = options.check ?? (async () => {
    const { stdout } = await exec("/bin/bash", [helper, "check"], { timeout: 25_000, maxBuffer: 128 * 1024 });
    return JSON.parse(stdout) as Update;
  });
  const launch = options.launch ?? (async (token: string) => {
    const log = await open(logPath, "a", 0o600);
    try {
      const child = spawn("/bin/bash", [helper, "run", token, String(process.pid)], {
        detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally { await log.close(); }
  });
  const showFailure = async (detail: string) => {
    await message({
      type: "error", title: "Rubato 업데이트",
      message: "업데이트를 마치지 못했어요.",
      detail, buttons: ["오류 기록 보기", "확인"],
    });
  };
  const stopWatching = () => {
    clearInterval(watcher);
    watcher = undefined;
    expectedToken = undefined;
    progress(-1);
  };
  const report = async () => {
    if (watching || stopped) return false;
    watching = true;
    try {
      const result = await read<Result>(resultPath);
      if (expectedToken && result?.token !== expectedToken) {
        if (now() < launchDeadline) return true;
        stopWatching();
        await showFailure("업데이트 작업을 시작하지 못했어요. 오류 기록을 확인한 뒤 다시 시도해 주세요.");
        return false;
      }
      if (!result) { stopWatching(); return false; }
      if (result.status === "running" && alive(result.pid)) {
        progress(2);
        return true;
      }
      const seen = await read<{ token: string }>(seenPath);
      stopWatching();
      if (seen?.token !== result.token) {
        if (result.status !== "succeeded") await showFailure(result.message ??
          "업데이트 작업이 중단됐어요. 오류 기록을 확인한 뒤 다시 시도해 주세요.");
        if (!stopped) await write(seenPath, { token: result.token });
      }
      return false;
    } finally { watching = false; }
  };
  const watch = () => {
    if (!watcher) {
      watcher = setInterval(() => { void report().catch(console.warn); }, options.watchMs ?? 1000);
      watcher.unref();
    }
  };
  const tick = async () => {
    if (stopped || busy || window.isDestroyed()) return;
    busy = true;
    try {
      if (await report()) { watch(); return; }
      if (now() < nextCheck) return;
      nextCheck = now() + CHECK_INTERVAL;
      const update = await check();
      if (!update.available || !update.revision || stopped) return;
      const postponed = await read<{ revision: string; until: number }>(path.join(stateDir, "later.json"));
      if (postponed?.revision === update.revision && postponed.until > now()) return;
      const answer = await message({
        type: "info", title: "Rubato 업데이트",
        message: "새 업데이트가 있어요.",
        detail: `새 변경 ${update.commits ?? 1}개를 받을 수 있어요.\n업데이트하면 앱이 닫혔다가 자동으로 다시 열려요. 진행 중인 작업이 끊길 수 있으니 먼저 마쳐 주세요.`,
        buttons: ["업데이트", "나중에"],
      });
      if (answer.response !== 0 || stopped) {
        await write(path.join(stateDir, "later.json"), { revision: update.revision, until: now() + 24 * 60 * 60_000 });
        return;
      }
      expectedToken = randomUUID();
      launchDeadline = now() + 15_000;
      progress(2);
      try {
        await launch(expectedToken);
        watch();
      } catch (error) {
        stopWatching();
        await showFailure(String(error));
      }
    } catch (error) {
      // An offline background check is not "up to date", nor a recurring modal.
      console.warn("Rubato update check:", error);
      nextCheck = now() + 15 * 60_000;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  const focus = () => { void tick(); };
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    stopWatching();
    window.removeListener("focus", focus);
  };
  window.on("focus", focus);
  window.once("closed", stop);
  return { tick, stop };
}

let controller: ReturnType<typeof createRubatoUpdater> | undefined;
let state: RubatoUpdateState = { phase: "idle" };
let pending: { id: string; resolve: (answer: { response: number }) => void } | undefined;
const windows = new Map<number, BrowserWindow>();
const applicationUrls = new Map<number, string>();
let registered = false;
let initializing: Promise<void> | undefined;
const STATE_CHANNEL = "rubato:update:state";
const ACTION_CHANNEL = "rubato:update:action";
const GET_CHANNEL = "rubato:update:get";
function publish(next: RubatoUpdateState) {
  state = next;
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.webContents.send(STATE_CHANNEL, state);
  }
}
async function acknowledgeWindow(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  if (window.webContents.isLoadingMainFrame()) {
    // did-finish-load can fire before isLoadingMainFrame flips to false.
    // Waiting on it again from that callback would miss this load forever.
    window.webContents.once("did-stop-loading", () => { void acknowledgeWindow(window).catch(console.warn); });
    return;
  }
  if (!window.isVisible()) {
    window.once("show", () => { void acknowledgeWindow(window).catch(console.warn); });
    return;
  }
  const stateDir = directory();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (restartToken && /^[a-f0-9-]{36}$/.test(restartToken)) {
    const token = restartToken;
    // The app shell has mounted AND its main window is loaded and visible.
    // A splash, preview or merely live launcher cannot acknowledge readiness.
    const lock = await read<{ token: string }>(path.join(stateDir, "lock.json"));
    if (lock?.token === token) await write(path.join(stateDir, `ready-${token}.json`),
      { token, pid: process.pid, loadedAt: Date.now() });
  }
}

export function authorizedUpdateWindow(event: IpcMainInvokeEvent) {
  const window = windows.get(event.sender.id);
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted update sender");
  const expected = new URL(applicationUrls.get(event.sender.id)!);
  const actual = new URL(event.senderFrame.url);
  if (actual.protocol !== expected.protocol || actual.host !== expected.host) throw new Error("Untrusted update origin");
  return window;
}

export function attachRubatoUpdates(window: BrowserWindow, electron: ElectronServices, settingsPath: string, applicationUrl: string) {
  if (process.platform !== "darwin" || process.env.VITE_DEV_SERVER_URL) return;
  const windowId = window.webContents.id;
  windows.set(windowId, window);
  applicationUrls.set(windowId, applicationUrl);
  if (!registered) {
    registered = true;
    electron.ipcMain.handle(GET_CHANNEL, async (event) => {
      const sender = authorizedUpdateWindow(event);
      await acknowledgeWindow(sender);
      await initializing;
      return state;
    });
    electron.ipcMain.handle(ACTION_CHANNEL, async (event, input: unknown) => {
      authorizedUpdateWindow(event);
      if (!input || typeof input !== "object") throw new Error("Invalid update action");
      const { id, action } = input as { id?: unknown; action?: unknown };
      if (!pending || id !== pending.id) throw new Error("Expired update prompt");
      if (state.phase === "failed" && action === "log") {
        const file = await open(path.join(directory(), "update.log"), "r").catch(() => undefined);
        let log = "오류 기록이 없어요.";
        if (file) {
          try {
            const { size } = await file.stat();
            const buffer = Buffer.alloc(Math.min(size, 16_384));
            await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            log = buffer.toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
          } finally { await file.close(); }
        }
        publish({ ...state, log });
        return;
      }
      const valid = state.phase === "available" ? ["update", "later"] : ["dismiss"];
      if (typeof action !== "string" || !valid.includes(action)) throw new Error("Invalid update action");
      const request = pending;
      pending = undefined;
      publish({ phase: action === "update" ? "running" : "idle" });
      request.resolve({ response: action === "update" ? 0 : 1 });
    });
  }
  if (!controller && !initializing) {
    initializing = (async () => {
      const stateDir = directory();
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      // write-gui-settings.mjs writes the provider wiring to the server
      // settings (userdata/settings.json). desktop-settings.json only holds
      // window state, so reading it left every install without an updater.
      const settings = await read<{ providerInstances?: { rubato?: { config?: { bridgeModule?: string } } } }>(settingsPath);
      const bridge = settings?.providerInstances?.rubato?.config?.bridgeModule;
      if (!bridge || !path.isAbsolute(bridge) || window.isDestroyed()) return;
      controller = createRubatoUpdater(window, {
        stateDir, helper: path.resolve(path.dirname(bridge), "..", "gui-update.sh"),
        message: (prompt) => new Promise((resolve) => {
          const id = randomUUID();
          pending = { id, resolve };
          publish({ phase: prompt.type === "error" ? "failed" : "available",
            id, message: prompt.message, detail: prompt.detail });
        }),
        progress: (value) => {
          if (!pending) publish({ phase: value === 2 ? "running" : "idle" });
        },
      });
      void controller.tick();
    })().catch((error) => { console.warn("Rubato updater:", error); });
  }
  window.once("closed", () => {
    windows.delete(windowId);
    applicationUrls.delete(windowId);
    if (windows.size === 0) {
      controller?.stop();
      controller = undefined;
      initializing = undefined;
      pending?.resolve({ response: 1 });
      pending = undefined;
    }
  });
}
