import { watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  excludeRoutineOnlySettingsChanges,
  isSettingsPath,
  updateSettingsContentSnapshot,
} from "./routine-settings.mjs";
import { excludeGeneratedExtensionShims } from "./shim-filter.mjs";

const CONFIG_FILE_NAMES = new Set(["settings.json", "settings.jsonc", "models.json", "keybindings.json"]);

function createFsSubscribe(directories) {
  const watchers = [];
  return (onEvent) => {
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, (eventType, filename) => {
          if (!filename) return;
          onEvent({ path: join(directory, filename.toString()), eventType });
        });
        watchers.push(watcher);
      } catch {
        // Directory may not exist yet.
      }
    }
    return () => {
      for (const watcher of watchers) watcher.close();
    };
  };
}

export function createConfigReloadExtension({
  settingsManager,
  agentDir,
  cwd,
  requestReload,
  subscribe,
  debounceMs = 200,
} = {}) {
  if (!settingsManager) throw new TypeError("config-reload requires the parent SettingsManager");
  if (!agentDir) throw new TypeError("config-reload requires agentDir");
  const resolvedAgentDir = resolve(agentDir);
  const resolvedCwd = resolve(cwd ?? process.cwd());
  const contents = new Map();
  for (const name of ["settings.json", "settings.jsonc"]) {
    updateSettingsContentSnapshot(contents, join(resolvedAgentDir, name));
    updateSettingsContentSnapshot(contents, join(resolvedCwd, ".pi", name));
  }

  return (pi) => {
    let timer;
    let pending = new Set();
    let closed = false;
    const reload = async (paths) => {
      const settingsChanged = paths.some((path) => isSettingsPath(path, resolvedAgentDir, resolvedCwd));
      if (settingsChanged) await settingsManager.reload();
      if (typeof requestReload === "function") await requestReload(paths);
      else if (!settingsChanged && typeof pi === "object") {
        // Stock event context has no requestReload; models/extensions wait for host reload.
      }
    };
    const flush = () => {
      timer = undefined;
      if (closed) return;
      let paths = [...pending];
      pending = new Set();
      paths = excludeGeneratedExtensionShims(paths, resolvedAgentDir);
      paths = excludeRoutineOnlySettingsChanges(paths, contents, resolvedAgentDir, resolvedCwd);
      if (paths.length === 0) return;
      void reload(paths);
    };
    const onEvent = (event) => {
      const path = resolve(event.path);
      const name = basename(path);
      const inExtensions = resolve(path, "..") === join(resolvedAgentDir, "extensions") || path.includes(`${join(resolvedAgentDir, "extensions")}`);
      if (!CONFIG_FILE_NAMES.has(name) && !inExtensions) return;
      pending.add(path);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    };
    const startSubscribe = subscribe ?? createFsSubscribe([
      resolvedAgentDir,
      join(resolvedAgentDir, "extensions"),
      join(resolvedCwd, ".pi"),
    ]);
    let unsubscribe = () => {};
    pi.on("session_start", () => {
      unsubscribe = startSubscribe(onEvent) ?? (() => {});
    });
    pi.on("session_shutdown", () => {
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  };
}

export default createConfigReloadExtension;
