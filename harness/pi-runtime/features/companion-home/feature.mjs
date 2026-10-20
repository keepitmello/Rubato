import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
// `home.mjs`, `inbox.mjs`, `world.mjs` and `schedule.mjs` are the files of the same name in
// harness/companion, kept here as links so there is one source. They import nothing local beyond
// each other (world and schedule import ./home.mjs), which is what lets them travel into the runtime
// build together.
const RUNTIME_FILES = Object.freeze(["index.mjs", "home.mjs", "inbox.mjs", "world.mjs", "schedule.mjs"]);

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
