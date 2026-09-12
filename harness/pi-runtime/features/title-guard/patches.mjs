import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-tui";
const VERSION = "0.85.1";
const GUARD_IMPORT = 'import { installTitleGuard } from "./rubato-features/title-guard/title-guard.mjs";';
const INJECT_MARKER = "rubato.titleGuard.injected";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[title-guard:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[title-guard:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[title-guard:" + label + "] expected pristine feature seam");
}

const IMPORT_BEFORE = 'import { StdinBuffer } from "./stdin-buffer.js";\n';
const IMPORT_AFTER = 'import { StdinBuffer } from "./stdin-buffer.js";\n' + GUARD_IMPORT + '\n';

const EOF_BEFORE = '}\n//# sourceMappingURL=terminal.js.map';
const EOF_AFTER = '}\ninstallTitleGuard(ProcessTerminal.prototype);\n// ' + INJECT_MARKER + '\n//# sourceMappingURL=terminal.js.map';

export function patchTerminalTitle(source) {
  unpatched(source, INJECT_MARKER, "title-guard-inject");
  if (!source.includes("class ProcessTerminal")) throw new Error("[title-guard:class] ProcessTerminal is missing");
  let next = replaceOnce(source, IMPORT_BEFORE, IMPORT_AFTER, "title-guard-import");
  return replaceOnce(next, EOF_BEFORE, EOF_AFTER, "title-guard-install");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/title-guard/title-guard.mjs",
    sourcePath: fileURLToPath(new URL("./title-guard.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "title-guard:terminal",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/terminal.js",
    preimageSha256: "d0b29feb487659b65797e5ed706c6cbb4859be9359c8539851a2ec6419a2b048",
    apply: patchTerminalTitle,
  }),
]);

export const feature = Object.freeze({ id: "title-guard", patches, files });
export default feature;
