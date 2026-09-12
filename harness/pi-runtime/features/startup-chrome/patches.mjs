import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const HEADER_IMPORT = 'import { BRAND_NAME, startupDisplayVersion } from "../../rubato-features/startup-chrome/header.mjs";\n';
const HIDE_EXTENSIONS_MARKER = "rubato.startupChrome.hideExtensions";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[startup-chrome:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[startup-chrome:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[startup-chrome:" + label + "] expected pristine feature seam");
}

const CONFIG_IMPORT = 'import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, getAgentDir, getAuthPath, getDebugLogPath, getDocsPath, VERSION, } from "../../config.js";\n';
const LOGO_BEFORE = '            const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);';
const LOGO_AFTER = '            const logo = theme.bold(theme.fg("accent", BRAND_NAME)) + theme.fg("dim", ` v${startupDisplayVersion(this.version)}`);';
const EXT_BEFORE = '                addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");';
const EXT_AFTER = '                // ' + HIDE_EXTENSIONS_MARKER;

export function patchStartupChrome(source) {
  unpatched(source, HEADER_IMPORT.trim(), "header-import");
  unpatched(source, HIDE_EXTENSIONS_MARKER, "hide-extensions");
  let next = replaceOnce(source, CONFIG_IMPORT, CONFIG_IMPORT + HEADER_IMPORT, "header-import");
  next = replaceOnce(next, LOGO_BEFORE, LOGO_AFTER, "header-logo");
  return replaceOnce(next, EXT_BEFORE, EXT_AFTER, "hide-extensions");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/startup-chrome/header.mjs",
    sourcePath: fileURLToPath(new URL("./header.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "startup-chrome:interactive",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/modes/interactive/interactive-mode.js",
    preimageSha256: "802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf",
    apply: patchStartupChrome,
  }),
]);

export const feature = Object.freeze({ id: "startup-chrome", patches, files });
export default feature;
