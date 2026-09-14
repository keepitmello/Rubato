const IMPORT = 'import { bindStockUiHost, resetStockUiHost, invalidateStockUiHost } from "../../../../../../rubato-features/remote-surface/stock-ui-host.mjs";\n';
function replaceOnce(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('[remote-surface:stock-ui-host] expected unique stock anchor');
  }
  return source.replace(before, after);
}

export function patchStockUiHost(source) {
  if (source.includes(IMPORT)) throw new Error('[remote-surface:stock-ui-host] already patched');
  let next = replaceOnce(source,
    '        this.runtimeHost.setBeforeSessionInvalidate(() => {\n            this.resetExtensionUI();',
    '        this.runtimeHost.setBeforeSessionInvalidate(() => {\n            invalidateStockUiHost(this);\n            this.resetExtensionUI();');
  next = replaceOnce(next,
    '    resetExtensionUI() {\n',
    '    resetExtensionUI() {\n        resetStockUiHost(this);\n');
  next = replaceOnce(next,
    '    async bindCurrentSessionExtensions() {\n        const uiContext = this.createExtensionUIContext();',
    '    async bindCurrentSessionExtensions() {\n        const uiContext = bindStockUiHost(this, this.createExtensionUIContext());');
  return IMPORT + next;
}

export const patches = Object.freeze([Object.freeze({
  id: 'stock-ui-host', packageName: '@earendil-works/pi-coding-agent', version: '0.85.1',
  path: 'dist/modes/interactive/interactive-mode.js',
  preimageSha256: '802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf',
  apply: patchStockUiHost,
})]);
