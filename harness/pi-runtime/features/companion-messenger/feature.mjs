import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
// Only the tool extension is staged: it reaches the messenger through the engine's sessionLink,
// so nothing from harness/companion has to travel with the runtime build.
const RUNTIME_FILES = Object.freeze(["index.mjs"]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/companion-messenger/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const companionMessengerFeature = Object.freeze({ id: "companion-messenger", patches, files });
export const feature = companionMessengerFeature;
export default companionMessengerFeature;
