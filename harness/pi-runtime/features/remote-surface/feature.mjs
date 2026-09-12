import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeProtocolBundle } from "./protocol-loader.mjs";

const VERSION = "0.85.1";
const PROTOCOL_BUNDLE = materializeProtocolBundle({
  dest: join(tmpdir(), "rubato-remote-protocol-feature-bundle", "protocol.mjs"),
});
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "surface.mjs",
  "stock-control.mjs",
  "session-metrics.mjs",
  "protocol-loader.mjs",
  "THIRD_PARTY_NOTICES.md",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze([
  ...RUNTIME_FILES.map((name) => Object.freeze({
    target: "runtime",
    version: VERSION,
    path: `rubato-features/remote-surface/${name}`,
    sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
  })),
  Object.freeze({
    target: "runtime",
    version: VERSION,
    path: "rubato-features/remote-surface/conversation-projection.mjs",
    sourcePath: fileURLToPath(new URL("../../../rubato-pi/src/remote-conversation-projection.mjs", import.meta.url)),
  }),
  Object.freeze({
    target: "runtime",
    version: VERSION,
    path: "rubato-features/remote-surface/interactive-control-surface.mjs",
    sourcePath: fileURLToPath(new URL("../../../rubato-pi/src/interactive-control-surface.mjs", import.meta.url)),
  }),
  Object.freeze({
    target: "runtime",
    version: VERSION,
    path: "rubato-features/remote-surface/protocol.mjs",
    sourcePath: PROTOCOL_BUNDLE,
  }),
]);

export const feature = Object.freeze({ id: "remote-surface", patches, files });
export default feature;
