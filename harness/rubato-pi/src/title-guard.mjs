// pi-tui's ProcessTerminal.setTitle writes an OSC 0 sequence on every call,
// even when the title text has not changed. senpi's interactive mode calls it
// from tool_execution_update, tool_hook_status, and tool start/end handlers, so
// a single streaming bash command can re-emit an identical title dozens of
// times per second. Terminals repaint the tab label on each OSC 0, which the
// user sees as the title flickering while the model is working.
//
// The guard remembers the last sequence written per terminal instance and skips
// the write when nothing changed. Distinct titles still go through immediately,
// so the tab stays accurate.

const GUARD_FLAG = Symbol.for("rubato.titleGuard.installed");
const LAST_TITLE = Symbol.for("rubato.titleGuard.lastTitle");

/**
 * Wraps setTitle on a ProcessTerminal-like prototype so repeated identical
 * titles do not re-emit the OSC 0 sequence.
 *
 * Returns true when the guard was installed, false when the prototype is not
 * patchable or was already guarded.
 */
export function installTitleGuard(proto) {
  if (proto == null || typeof proto !== "object") return false;
  if (proto[GUARD_FLAG]) return false;
  const original = proto.setTitle;
  if (typeof original !== "function") return false;

  proto.setTitle = function guardedSetTitle(title) {
    // Mirror pi-tui's own sanitization so the comparison key matches the bytes
    // that would actually reach the terminal.
    const sanitized = String(title ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    if (this[LAST_TITLE] === sanitized) return undefined;
    this[LAST_TITLE] = sanitized;
    return original.call(this, sanitized);
  };
  proto[GUARD_FLAG] = true;
  return true;
}

/**
 * Applies the guard to a loaded pi-tui module namespace.
 */
export function guardTerminalModule(mod) {
  const terminal = mod?.ProcessTerminal;
  if (typeof terminal !== "function") return false;
  return installTitleGuard(terminal.prototype);
}

/** Matches pi-tui's terminal module, which is where ProcessTerminal lives. */
export function isTerminalModuleUrl(url) {
  return url.includes("pi-tui/dist/terminal.js");
}

const INJECT_MARKER = "rubato.titleGuard.injected";

/**
 * Appends the guard installation to pi-tui's terminal module source. The class
 * exists by the time the appended statement runs, so patching the prototype
 * here covers every ProcessTerminal instance without touching node_modules.
 */
export function injectTitleGuard(source, guardHref) {
  if (source.includes(INJECT_MARKER)) return source;
  if (!source.includes("class ProcessTerminal")) return source;
  return `${source}
// ${INJECT_MARKER}
const { installTitleGuard: __rubatoInstallTitleGuard } = await import(${JSON.stringify(guardHref)});
__rubatoInstallTitleGuard(ProcessTerminal.prototype);
`;
}

export function titleGuardHref() {
  return import.meta.url;
}
