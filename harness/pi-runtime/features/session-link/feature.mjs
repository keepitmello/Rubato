import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "extension.mjs",
  "message.mjs",
  "tools.mjs",
  "render.mjs",
  "host-sdk.mjs",
  "side-chat.mjs",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/session-link/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const sessionLinkFeature = Object.freeze({ id: "session-link", patches, files });
export const feature = sessionLinkFeature;
export default sessionLinkFeature;
