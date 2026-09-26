// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- A plain Electron IPC module beside RubatoUpdates, outside the Effect runtime.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type {
  RubatoPermissionAction,
  RubatoPermissionId,
  RubatoPermissionStatus,
  RubatoPermissionsState,
} from "@t3tools/contracts";
import { MAC_PERMISSION_SETTINGS_URLS, type MacPermission } from "./MacPermission.ts";
import { MacPermissionHelper, macAppBundlePath } from "./MacPermissionHelper.ts";

// macOS privacy permissions for the Rubato app and everything it spawns.
// Session commands (screencapture, osascript) run as children of this app,
// so macOS checks the grant against Rubato.app, not against the tool.

type ElectronServices = Pick<
  typeof import("electron"),
  "ipcMain" | "systemPreferences" | "desktopCapturer" | "shell" | "app" | "nativeImage"
>;

const exec = promisify(execFile);
const GET_CHANNEL = "rubato:permissions:get";
const ACTION_CHANNEL = "rubato:permissions:action";
const IDS: readonly RubatoPermissionId[] = ["screen", "accessibility", "fullDisk", "automation"];
const ACTIONS: readonly RubatoPermissionAction[] = [
  "request", "open", "reset", "relaunch", "cua-install", "cua-start", "cua-grant", "cua-update",
];
// Cua Driver is the computer-use backend. It runs as its own daemon app, so its
// grants belong to CuaDriver.app, not to Rubato.
const CUA_APP = "/Applications/CuaDriver.app";
const CUA_BIN = `${CUA_APP}/Contents/MacOS/cua-driver`;
// The vendor's documented installer: puts CuaDriver.app in /Applications and
// cua-driver on PATH (~/.local/bin), preserving grants across compatible releases.
const CUA_INSTALLER = 'curl -fsSL https://cua.ai/driver/install.sh | /bin/bash';
const AUTOMATION_TARGET = "com.apple.systemevents";
const AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
// tccutil service names. Resetting drops a grant that was tied to an older build.
const TCC_SERVICES: Record<RubatoPermissionId, string> = {
  screen: "ScreenCapture",
  accessibility: "Accessibility",
  fullDisk: "SystemPolicyAllFiles",
  automation: "AppleEvents",
};
// Permissions T3's drag helper can place into the System Settings list.
const HELPER_PERMISSIONS: Partial<Record<RubatoPermissionId, MacPermission>> = {
  screen: "screen-recording",
  accessibility: "accessibility",
  fullDisk: "full-disk-access",
};

const userTccDb = () =>
  path.join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
// Folders only Full Disk Access can list. macOS 27 no longer keeps a per-user
// TCC folder, so several are tried; the first that exists decides.
const fullDiskProbes = () => [
  "/Library/Application Support/com.apple.TCC",
  path.join(homedir(), "Library", "Safari"),
  path.join(homedir(), "Library", "Mail"),
];

const windows = new Map<number, { window: BrowserWindow; origin: string }>();
let registered = false;
let helper: MacPermissionHelper | undefined;
// An Apple Event probe is the only status source without Full Disk Access.
let automationProbe: RubatoPermissionStatus | undefined;
let bundleInfo: Promise<{ bundle: string | null; id: string | null }> | undefined;

function authorizedWindow(event: IpcMainInvokeEvent) {
  const entry = windows.get(event.sender.id);
  if (
    !entry ||
    entry.window.isDestroyed() ||
    event.senderFrame !== entry.window.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== entry.origin
  ) {
    throw new Error("Untrusted permissions sender");
  }
  return entry.window;
}

function readBundleInfo(electron: ElectronServices) {
  bundleInfo ??= (async () => {
    const bundle = macAppBundlePath(electron.app.getPath("exe")) ?? null;
    if (!bundle) return { bundle, id: null };
    const id = await exec("/usr/bin/plutil", [
      "-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist"),
    ]).then(({ stdout }) => stdout.trim(), () => "");
    return { bundle, id: /^[A-Za-z0-9.-]+$/.test(id) ? id : null };
  })();
  return bundleInfo;
}

async function signing(bundle: string | null): Promise<RubatoPermissionsState["signing"]> {
  if (!bundle) return "unknown";
  try {
    const { stdout, stderr } = await exec("/usr/bin/codesign", ["-dr", "-", bundle]);
    const text = `${stdout}\n${stderr}`;
    if (/certificate (leaf|root)/.test(text)) return "stable";
    if (/cdhash/.test(text)) return "adhoc";
  } catch {}
  return "unknown";
}

async function fullDiskAccess(): Promise<RubatoPermissionStatus> {
  for (const folder of fullDiskProbes()) {
    try {
      await readdir(folder);
      return "granted";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return "denied";
    }
  }
  return "unknown";
}

async function automationFromTcc(bundleId: string | null): Promise<RubatoPermissionStatus> {
  if (!bundleId) return "unknown";
  try {
    const { stdout } = await exec("/usr/bin/sqlite3", [
      "-readonly",
      userTccDb(),
      `select auth_value from access where service='kTCCServiceAppleEvents' and client='${bundleId}' and indirect_object_identifier='${AUTOMATION_TARGET}';`,
    ]);
    const value = stdout.trim();
    if (value === "2" || value === "3") return "granted";
    if (value === "0") return "denied";
  } catch {}
  return "unknown";
}

async function probeAutomation(): Promise<RubatoPermissionStatus> {
  // Asks macOS the first time. Denied answers fail at once with -1743.
  try {
    await exec(
      "/usr/bin/osascript",
      ["-e", `tell application id "${AUTOMATION_TARGET}" to count processes`],
      { timeout: 120_000 },
    );
    return "granted";
  } catch (error) {
    const text = String((error as { stderr?: unknown }).stderr ?? "");
    return /-1743|not authori[sz]ed|허용되지/i.test(text) ? "denied" : "unknown";
  }
}

// Output of a cua-driver command, including on a non-zero exit ("daemon is not running").
const cuaText = (args: string[], timeout = 15_000) =>
  exec(CUA_BIN, args, { timeout }).then(
    ({ stdout, stderr }) => `${stdout}${stderr}`,
    (error: { stdout?: unknown; stderr?: unknown }) => `${error.stdout ?? ""}${error.stderr ?? ""}`,
  );

async function cuaState(): Promise<RubatoPermissionsState["cua"]> {
  const version = (await cuaText(["--version"])).match(/cua-driver\s+(\S+)/)?.[1] ?? null;
  if (!version) {
    return { installed: false, version: null, latest: null, running: false, accessibility: "unknown", screenRecording: "unknown" };
  }
  const running = /daemon is running/.test(await cuaText(["status"]));
  let accessibility: RubatoPermissionStatus = "unknown";
  let screenRecording: RubatoPermissionStatus = "unknown";
  if (running) {
    try {
      const status = JSON.parse(await cuaText(["permissions", "status", "--json"])) as {
        accessibility?: boolean; screen_recording?: boolean;
      };
      accessibility = status.accessibility ? "granted" : "denied";
      screenRecording = status.screen_recording ? "granted" : "denied";
    } catch {}
  }
  let latest: string | null = null;
  try {
    // Cached by the driver for 20h, so polling this page does not hit GitHub.
    latest = (JSON.parse(await cuaText(["check-update", "--json"])) as { latest_version?: string }).latest_version ?? null;
  } catch {}
  return { installed: true, version, latest, running, accessibility, screenRecording };
}

let cuaTask: Promise<unknown> | undefined;
async function startCua() {
  // LaunchServices, so the daemon is its own responsible process and asks with its own identity.
  await exec("/usr/bin/open", ["-g", "-a", CUA_APP]).catch(() => undefined);
  for (let i = 0; i < 20 && !/daemon is running/.test(await cuaText(["status"])); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function cuaAction(action: RubatoPermissionAction) {
  if (action === "cua-start") return startCua();
  if (action === "cua-grant") {
    await startCua();
    // Walks the user through the prompts and waits for them; the page polls meanwhile.
    cuaTask ??= exec(CUA_BIN, ["permissions", "grant"], { timeout: 600_000 })
      .catch(() => undefined).finally(() => { cuaTask = undefined; });
    return;
  }
  const command = action === "cua-install" ? CUA_INSTALLER : `${JSON.stringify(CUA_BIN)} update --apply`;
  await exec("/bin/bash", ["-lc", command], { timeout: 600_000 });
  await startCua();
}

async function readState(electron: ElectronServices): Promise<RubatoPermissionsState> {
  const { bundle, id } = await readBundleInfo(electron);
  const disk = await fullDiskAccess();
  let automation = automationProbe ?? "unknown";
  if (disk === "granted") {
    const recorded = await automationFromTcc(id);
    if (recorded !== "unknown") automation = recorded;
  }
  const statuses: Record<RubatoPermissionId, RubatoPermissionStatus> = {
    screen: electron.systemPreferences.getMediaAccessStatus("screen") === "granted" ? "granted" : "denied",
    accessibility: electron.systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    fullDisk: disk,
    automation,
  };
  return {
    cua: await cuaState(),
    appPath: bundle,
    bundleId: id,
    signing: await signing(bundle),
    items: IDS.map((permission) => ({ id: permission, status: statuses[permission] })),
  };
}

// The helper takes PNG paths, like T3's own permission flow. Do not ask macOS
// for the bundle icon: app.getFileIcon() crashed the whole app inside
// IconLoader::ReadIcon (Electron 44, SIGTRAP on a pool thread) the moment a
// grant opened this panel. install-gui.sh lays the Rubato PNG where T3 reads its
// icon, so the source build carries it under assets/prod.
const helperIconPaths = () => [
  path.join(__dirname, "../resources/icon.png"),
  path.join(__dirname, "../../../assets/prod/black-macos-1024.png"),
  path.join(__dirname, "../../../assets/prod/black-universal-1024.png"),
];

async function openSettings(
  electron: ElectronServices,
  permission: RubatoPermissionId,
  owner: BrowserWindow,
) {
  const pane = HELPER_PERMISSIONS[permission];
  await electron.shell.openExternal(pane ? MAC_PERMISSION_SETTINGS_URLS[pane] : AUTOMATION_SETTINGS_URL);
  const { bundle } = await readBundleInfo(electron);
  if (!pane || !bundle) return;
  // The floating panel lets the user drag Rubato into the list, which is the
  // only way to add an app that macOS has not listed yet (Full Disk Access).
  helper ??= new MacPermissionHelper();
  const isGranted = async () =>
    (await readState(electron)).items.find((item) => item.id === permission)?.status === "granted";
  await helper
    .show(pane, path.join(__dirname, "mac-permission-preload.cjs"), owner, helperIconPaths(), isGranted)
    .catch((error) => console.warn("Rubato permission helper:", error));
}

async function request(electron: ElectronServices, permission: RubatoPermissionId, owner: BrowserWindow) {
  if (permission === "screen") {
    // Registers the app in the list and shows macOS's own prompt once.
    await electron.desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => undefined);
  } else if (permission === "accessibility") {
    electron.systemPreferences.isTrustedAccessibilityClient(true);
  } else if (permission === "automation") {
    automationProbe = await probeAutomation();
  }
  const state = await readState(electron);
  if (state.items.find((item) => item.id === permission)?.status !== "granted") {
    await openSettings(electron, permission, owner);
  }
}

async function reset(electron: ElectronServices, permission: RubatoPermissionId) {
  const { id } = await readBundleInfo(electron);
  if (!id) throw new Error("Rubato bundle id is unknown");
  await exec("/usr/bin/tccutil", ["reset", TCC_SERVICES[permission], id]);
  if (permission === "automation") automationProbe = undefined;
}

export function attachRubatoPermissions(
  window: BrowserWindow,
  electron: ElectronServices,
  applicationUrl: string,
) {
  if (process.platform !== "darwin") return;
  const windowId = window.webContents.id;
  windows.set(windowId, { window, origin: new URL(applicationUrl).origin });
  window.once("closed", () => windows.delete(windowId));
  if (registered) return;
  registered = true;
  // Agents reach the computer-use daemon only while it runs; bring it up with the app.
  void (async () => {
    if (!(await cuaText(["--version"])).includes("cua-driver")) return;
    if (!/daemon is running/.test(await cuaText(["status"]))) await startCua();
  })();
  electron.ipcMain.handle(GET_CHANNEL, async (event) => {
    authorizedWindow(event);
    return readState(electron);
  });
  electron.ipcMain.handle(ACTION_CHANNEL, async (event, input: unknown) => {
    const owner = authorizedWindow(event);
    const { id, action } = (input ?? {}) as { id?: unknown; action?: unknown };
    if (!ACTIONS.includes(action as RubatoPermissionAction)) throw new Error("Invalid permission action");
    if (action === "relaunch") {
      // Screen Recording applies to this process only after a restart.
      electron.app.relaunch();
      electron.app.quit();
      return readState(electron);
    }
    if (typeof action === "string" && action.startsWith("cua-")) {
      await cuaAction(action as RubatoPermissionAction);
      return readState(electron);
    }
    if (!IDS.includes(id as RubatoPermissionId)) throw new Error("Invalid permission");
    const permission = id as RubatoPermissionId;
    if (action === "open") await openSettings(electron, permission, owner);
    else if (action === "reset") {
      await reset(electron, permission);
      await request(electron, permission, owner);
    } else await request(electron, permission, owner);
    return readState(electron);
  });
}
