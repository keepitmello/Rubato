import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as VERSION } from "../../pi-version.mjs";
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
// 1.0 puts the pi half-block logo (or a colored "Pi" on Apple Terminal) with the engine
// version on the first two header lines and plays a 3D logo on click. Rubato keeps its
// one-line brand header: the wordmark with the product version, key hints below it.
const LOGO_BEFORE = `            const showLogo = supportsPiLogo();
            const withLogo = (hints) => {
                if (!showLogo)
                    return \`\${piWordmark()} \${theme.fg("dim", \`v\${this.version}\`)}\\n\${hints}\`;
                const [top, bottom] = piLogoLines();
                return \`\${top} \${theme.fg("dim", \`v\${this.version}\`)}\\n\${bottom} \${hints}\`;
            };`;
const LOGO_AFTER = `            const showLogo = false;
            const withLogo = (hints) => \`\${theme.bold(theme.fg("accent", BRAND_NAME)) + theme.fg("dim", \` v\${startupDisplayVersion(this.version)}\`)}\\n\${hints}\`;`;
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
    preimageSha256: "14508d43f3dd47faa6b10c4a6537740f1cf238eee3fc873a9e0648125214bbcc",
    apply: patchStartupChrome,
  }),
]);

export const feature = Object.freeze({ id: "startup-chrome", patches, files });
export default feature;
