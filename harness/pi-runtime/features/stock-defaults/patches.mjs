import { readFileSync } from "node:fs";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";

// pi 0.99–1.0 changed defaults the user froze on 2026-10-03 (intent pi-1-0-upgrade,
// "TUI 모드·테마는 지금 동작 유지, 내장 codemode·tool-search·mcp 끔, 설치 텔레메트리 끔").
// These patches put the engine defaults back without writing any profile setting, so an
// explicit user setting still wins over each of them.
//
// - Built-in extensions: 0.99 always loads builtin:codemode, builtin:tool-search and
//   builtin:mcp. Rubato ships its own; the built-in tool_search registers first and shadows
//   ours. They stay out unless RUBATO_PI_BUILTIN_EXTENSIONS names them (comma list), which
//   only the codemode/tool-search comparison sets. llama.cpp predates 0.99 and stays.
// - TUI mode: 1.0.0 opens fullscreen unless `tuiMode` is "regular". Back to regular unless
//   it is "fullscreen".
// - Theme: 0.99 resolves an unset theme to `system` and recoloured the built-in dark/light.
//   An unset theme resolves to dark or light from the terminal again, and dark/light carry
//   the 0.86.1 palettes (theme-*-0.86.1.json, plus the `appearance` field 0.99 reads).
// - Install telemetry: `enableInstallTelemetry` unset meant on. Unset now means off;
//   `PI_TELEMETRY` and an explicit setting still decide.

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const BUILTINS_OFF_BY_DEFAULT = Object.freeze(["codemode", "tool-search", "mcp"]);
export const BUILTINS_ENV = "RUBATO_PI_BUILTIN_EXTENSIONS";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[stock-defaults:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[stock-defaults:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id: `stock-defaults:${id}`, packageName: PACKAGE_NAME, version: VERSION, path, preimageSha256, apply });
}

export function patchBuiltinExtensions(source) {
  return replaceOnce(
    replaceOnce(source,
      "export const builtInExtensions = [",
      `// Rubato: ${BUILTINS_OFF_BY_DEFAULT.join(", ")} stay off unless ${BUILTINS_ENV} names them.
const RUBATO_OFF_BY_DEFAULT = new Set(${JSON.stringify(BUILTINS_OFF_BY_DEFAULT)});
const RUBATO_ENABLED_BUILTINS = new Set((process.env.${BUILTINS_ENV} ?? "").split(",").map((name) => name.trim()).filter(Boolean));
const stockBuiltInExtensions = [`,
      "builtins-list"),
    "];\n//# sourceMappingURL=index.js.map",
    `];
export const builtInExtensions = stockBuiltInExtensions.filter((extension) => !RUBATO_OFF_BY_DEFAULT.has(extension.name) || RUBATO_ENABLED_BUILTINS.has(extension.name));
//# sourceMappingURL=index.js.map`,
    "builtins-filter",
  );
}

export function patchSettingsDefaults(source) {
  let next = replaceOnce(source,
    `        return this.settings.enableInstallTelemetry ?? true;`,
    `        return this.settings.enableInstallTelemetry ?? false;`,
    "telemetry-default");
  next = replaceOnce(next,
    `        return this.settings.tuiMode === "regular" ? "regular" : "fullscreen";`,
    `        return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";`,
    "tui-mode-default");
  return next;
}

export function patchThemeDefault(source) {
  return replaceOnce(source,
    `        return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;`,
    `        return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? (getTerminalTheme() === "light" ? "light" : "dark");`,
    "theme-unset-default");
}

const themeFile = (name) => readFileSync(new URL(`./theme-${name}-0.86.1.json`, import.meta.url), "utf8");
export const replaceTheme = (name) => (source) => {
  if (!source.includes(`"name": "${name}"`)) throw new Error(`[stock-defaults:theme-${name}] expected the stock ${name} theme`);
  return themeFile(name);
};

export const patches = Object.freeze([
  patch("builtin-extensions", "dist/extensions/index.js", "ed7f805d46160c30db9be874b2350d0bd01f8b390f94a55ec1d8d4ed9474bf9b", patchBuiltinExtensions),
  patch("settings-defaults", "dist/core/settings-manager.js", "b3a424ac1af9bd0c380796f9e5d812e2c61755ed3b31dd39982a57bbe0d5a391", patchSettingsDefaults),
  patch("theme-default", "dist/modes/interactive/theme/theme-controller.js", "a2eb66dbd859a12bdc5349731704d2fdcea4a3bd60b81091e42b4ea0f465de8e", patchThemeDefault),
  patch("theme-dark", "dist/modes/interactive/theme/dark.json", "c11a588b714d35300293079b425fb09a3693d4b2d453585d211b08163c648b75", replaceTheme("dark")),
  patch("theme-light", "dist/modes/interactive/theme/light.json", "f590c51c2bc8b238891efd0e983473ed2e2a6487b6692cc1d4b2845165e703f7", replaceTheme("light")),
]);

export const files = Object.freeze([]);
export const stockDefaultsFeature = Object.freeze({ id: "stock-defaults", patches, files });
export default stockDefaultsFeature;
