const GUARD_FLAG = Symbol.for("rubato.titleGuard.installed");
const LAST_TITLE = Symbol.for("rubato.titleGuard.lastTitle");

export function installTitleGuard(proto) {
  if (proto == null || typeof proto !== "object") return false;
  if (proto[GUARD_FLAG]) return false;
  const original = proto.setTitle;
  if (typeof original !== "function") return false;

  proto.setTitle = function guardedSetTitle(title) {
    const sanitized = String(title ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    if (this[LAST_TITLE] === sanitized) return undefined;
    this[LAST_TITLE] = sanitized;
    return original.call(this, sanitized);
  };
  proto[GUARD_FLAG] = true;
  return true;
}

export function guardTerminalModule(mod) {
  const terminal = mod?.ProcessTerminal;
  if (typeof terminal !== "function") return false;
  return installTitleGuard(terminal.prototype);
}
