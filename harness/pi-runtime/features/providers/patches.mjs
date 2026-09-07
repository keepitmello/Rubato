import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-ai";
const PACKAGE_VERSION = "0.85.1";

const source = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const ownedFile = (path, sourcePath) => Object.freeze({
  target: "package",
  packageName: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  path,
  sourcePath,
});

function preserveOAuthCredentialEnv(sourceText) {
  const before = '        return { auth: await oauth.toAuth(credential), source: "OAuth" };';
  const after = '        return { auth: await oauth.toAuth(credential), env: credential.env, source: "OAuth" };';
  const first = sourceText.indexOf(before);
  if (first === -1 || sourceText.indexOf(before, first + before.length) !== -1) {
    throw new Error("[providers:oauth-credential-env] expected stock anchor exactly once");
  }
  return sourceText.slice(0, first) + after + sourceText.slice(first + before.length);
}

const rubatoSources = Object.freeze([
  "anthropic-server-compaction-wire.mjs",
  "anthropic-server-compaction.mjs",
  "anthropic-setup-token.mjs",
  "antigravity-api.mjs",
  "antigravity-oauth-login.mjs",
  "antigravity-route.mjs",
  "antigravity-state.mjs",
  "cache-audit.mjs",
  "compaction-guidance.mjs",
  "context-notes/checkpoint.mjs",
  "context-notes/config.mjs",
  "context-notes/engine-gate.mjs",
  "context-notes/history-source.mjs",
  "context-notes/protocol.mjs",
  "credential-import.mjs",
  "cursor-grok-fast.mjs",
  "cursor-picker.mjs",
  "cursor-route.mjs",
  "kiro-route.mjs",
  "measurement-recorder.mjs",
  "mid-conversation-effort.mjs",
  "network-health.mjs",
  "opencode-keychain.mjs",
  "picker-catalog.mjs",
  "process-start.mjs",
  "provider-capabilities.mjs",
  "provider-direct.mjs",
  "rubato-stream.mjs",
  "speed-index-identity.mjs",
  "speed-index-routes.mjs",
  "speed-index-store.mjs",
  "speed-index.mjs",
  "upstream-dispatcher.mjs",
]);

// These are the only Senpi pi-ai runtime files retained. They are the exact
// Cursor provider/HTTP2/protobuf/OAuth closure that stock 0.85.1 does not ship;
// all common model/auth/session helpers continue to resolve from stock pi-ai.
const cursorOwnedTargets = Object.freeze([
  "api/cursor-agent.js",
  "api/cursor-agent.lazy.js",
  "api/cursor-agent/deterministic-id.js",
  "api/cursor-agent/exec-lifecycle.js",
  "api/cursor-agent/exec-modern.js",
  "api/cursor-agent/gen/agent_pb.js",
  "api/cursor-agent/measure.js",
  "api/cursor-agent/pi-args.js",
  "api/cursor-agent/reasoning-params.js",
  "api/cursor-agent/stream-retry.js",
  "api/cursor-conversation-rotation.js",
  "api/cursor-task-args.js",
  "auth/oauth/cursor.js",
  "cursor/catalog-grouping.js",
  "cursor/composer-prompt.js",
  "cursor/cursor-variant-aliases.json",
  "cursor/model-capabilities.js",
  "cursor/selection-descriptor.js",
  "cursor/store-migration.js",
  "providers/cursor.js",
  "utils/block-symbols.js",
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "providers:oauth-credential-env",
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/auth/resolve.js",
    preimageSha256: "82ee45ecec319f59536759312a4de25313a8bb8cb7ce43db43d18edc10fef305",
    apply: preserveOAuthCredentialEnv,
  }),
]);

export const files = Object.freeze([
  ownedFile("dist/rubato-features/providers/extension.mjs", source("./extension.mjs")),
  ownedFile("dist/rubato-features/providers/src/engine-paths.mjs", source("./engine-paths.mjs")),
  ownedFile("dist/rubato-features/providers/cursor-lazy.mjs", source("./cursor-lazy.mjs")),
  ownedFile(
    "dist/rubato-features/providers/cursor-event-stream.mjs",
    source("./vendor/pi-ai/utils/event-stream.js"),
  ),
  ownedFile(
    "dist/rubato-features/providers/cursor-read-image.mjs",
    source("../../../rubato-pi/src/transforms/cursor-read-image.mjs"),
  ),
  ownedFile("dist/rubato-features/providers/THIRD_PARTY_NOTICES.md", source("./THIRD_PARTY_NOTICES.md")),
  ownedFile(
    "dist/rubato-features/providers/data/speed-index-baseline-v0.json",
    source("../../../rubato-pi/data/speed-index-baseline-v0.json"),
  ),
  ownedFile(
    "dist/rubato-features/scripts/kiro-setup.sh",
    source("../../../scripts/kiro-setup.sh"),
  ),
  ...rubatoSources.map((path) => ownedFile(
    `dist/rubato-features/providers/src/${path}`,
    source(`../../../rubato-pi/src/${path}`),
  )),
  ...cursorOwnedTargets.map((path) => ownedFile(
    `dist/${path}`,
    source(`./vendor/pi-ai/${path}`),
  )),
]);

export const providersFeature = Object.freeze({
  id: "providers",
  patches,
  files,
});
