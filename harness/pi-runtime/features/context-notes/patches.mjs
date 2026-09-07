import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";

const source = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const ownedFile = (path, sourcePath) => Object.freeze({
  target: "package",
  packageName: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  path,
  sourcePath,
});

const contextNoteSources = Object.freeze([
  "checkpoint.mjs",
  "config.mjs",
  "controller.mjs",
  "engine-gate.mjs",
  "history-source.mjs",
  "journal.mjs",
  "mode-policy.mjs",
  "protocol.mjs",
  "reminder.mjs",
  "store.mjs",
  "tools.mjs",
]);

export const patches = Object.freeze([]);

export const files = Object.freeze([
  ownedFile("dist/rubato-features/context-notes/extension.mjs", source("./extension.mjs")),
  ownedFile(
    "dist/rubato-features/context-notes/src/extensions/context-notes.mjs",
    source("../../../rubato-pi/src/extensions/context-notes.mjs"),
  ),
  ...contextNoteSources.map((path) => ownedFile(
    `dist/rubato-features/context-notes/src/context-notes/${path}`,
    source(`../../../rubato-pi/src/context-notes/${path}`),
  )),
]);

export const feature = Object.freeze({ id: "context-notes", patches, files });
