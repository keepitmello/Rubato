import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
// `home.mjs`, `inbox.mjs` and `companion.mjs` are the files of the same name in harness/companion,
// kept here as links so there is one source. They import nothing local, which is what lets them
// travel into the runtime build at all.
const RUNTIME_FILES = Object.freeze(["index.mjs", "home.mjs", "inbox.mjs", "companion.mjs"]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/companion-home/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const companionHomeFeature = Object.freeze({ id: "companion-home", patches, files });
export const feature = companionHomeFeature;
export default companionHomeFeature;
