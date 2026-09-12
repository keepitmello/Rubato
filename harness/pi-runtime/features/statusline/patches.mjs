import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const FOOTER_IMPORT = 'import { theme } from "../theme/theme.js";\n';
const FOOTER_IMPORT_AFTER = FOOTER_IMPORT + 'import { renderRubatoStatusline } from "../../../rubato-features/statusline/footer.mjs";\n';
const RENDER_BEFORE = '    render(width) {\n        const state = this.session.state;';
const RENDER_AFTER = '    render(width) {\n        return renderRubatoStatusline(this, width, theme);\n        const state = this.session.state;';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[statusline:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[statusline:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[statusline:" + label + "] expected pristine feature seam");
}

function patchFooter(source) {
  unpatched(source, 'renderRubatoStatusline', 'footer-import');
  let next = replaceOnce(source, FOOTER_IMPORT, FOOTER_IMPORT_AFTER, 'footer-import');
  next = replaceOnce(next, RENDER_BEFORE, RENDER_AFTER, 'footer-render');
  return next;
}

const OWNED_FILES = ["brand.mjs", "speed-index.mjs", "cursor-grok-fast.mjs", "statusline.mjs", "footer.mjs"];
export const files = Object.freeze(OWNED_FILES.map((name) => Object.freeze({
  packageName: PACKAGE_NAME,
  version: VERSION,
  path: "dist/rubato-features/statusline/" + name,
  sourcePath: fileURLToPath(new URL("./" + name, import.meta.url)),
})));

export const patches = Object.freeze([
  Object.freeze({
    id: 'statusline:footer',
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: 'dist/modes/interactive/components/footer.js',
    preimageSha256: '05cc0ab96cbdacf15a34f4e2a9a3ee0395abaeaac638c1c153632cb0befbc9d1',
    apply: patchFooter,
  }),
]);

export const feature = Object.freeze({ id: 'statusline', patches, files });
export default feature;
