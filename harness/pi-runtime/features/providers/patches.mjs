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
const codingAgentFile = (path, sourcePath) => Object.freeze({
  target: "package",
  packageName: "@earendil-works/pi-coding-agent",
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

function replaceOnce(sourceText, before, after, label) {
  const first = sourceText.indexOf(before);
  if (first === -1 || sourceText.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[providers:${label}] expected stock anchor exactly once`);
  }
  return sourceText.slice(0, first) + after + sourceText.slice(first + before.length);
}

function patchResolveAuth(sourceText) {
  let next = replaceOnce(
    sourceText,
    'import { formatThrownValue } from "../utils/diagnostics.js";\n',
    'import { formatThrownValue } from "../utils/diagnostics.js";\nimport { mergeRefreshed, mergeRefreshedSlot, projectSlot } from "../rubato-features/providers/auth-pool/slots.mjs";\n',
    "resolve-pool-import",
  );
  next = replaceOnce(
    next,
    `    const stored = await readCredential(credentials, provider.id, signal);
    if (stored) {
        if (stored.type === "oauth" && provider.auth.oauth) {
            return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, stored, signal, overrides?.minOAuthValidityMs);
        }`,
    `    const stored = await readCredential(credentials, provider.id, signal);
    const slotName = overrides?.slotName;
    if (slotName !== undefined) {
        const projected = stored === undefined ? undefined : projectSlot(stored, slotName);
        if (!projected) return undefined;
        if (projected.type === "oauth" && provider.auth.oauth) {
            return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, projected, signal, overrides?.minOAuthValidityMs, slotName);
        }
        if (projected.type === "api_key" && provider.auth.apiKey) {
            const credential = overrides?.env ? { ...projected, env: { ...projected.env, ...overrides.env } } : projected;
            return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
        }
        return undefined;
    }
    if (stored) {
        if (stored.type === "oauth" && provider.auth.oauth) {
            return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, stored, signal, overrides?.minOAuthValidityMs);
        }`,
    "resolve-slot-name",
  );
  next = replaceOnce(
    next,
    "async function resolveStoredOAuth(credentials, providerId, oauth, stored, signal, minOAuthValidityMs) {",
    "async function resolveStoredOAuth(credentials, providerId, oauth, stored, signal, minOAuthValidityMs, slotName) {",
    "resolve-oauth-signature",
  );
  next = replaceOnce(
    next,
    `            post = await credentials.modify(providerId, async (current) => {
                if (current?.type !== "oauth")
                    return undefined; // logged out meanwhile
                if (!expiresSoon(current))
                    return undefined; // another process/request refreshed
                try {
                    const refreshSignal = AbortSignal.any([
                        signal,
                        AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
                    ]);
                    return await oauth.refresh(current, refreshSignal);`,
    `            post = await credentials.modify(providerId, async (current) => {
                if (current?.type !== "oauth")
                    return undefined; // logged out meanwhile
                const view = slotName === undefined ? current : projectSlot(current, slotName);
                if (view?.type !== "oauth")
                    return undefined;
                if (!expiresSoon(view))
                    return undefined; // another process/request refreshed
                try {
                    const refreshSignal = AbortSignal.any([
                        signal,
                        AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
                    ]);
                    const refreshed = await oauth.refresh(view, refreshSignal);
                    return slotName === undefined ? mergeRefreshed(current, refreshed) : mergeRefreshedSlot(current, slotName, refreshed);`,
    "resolve-oauth-merge",
  );
  next = replaceOnce(
    next,
    `        if (post?.type !== "oauth")
            return undefined; // logged out meanwhile
        credential = post;`,
    `        if (post?.type !== "oauth")
            return undefined; // logged out meanwhile
        const postView = slotName === undefined ? post : projectSlot(post, slotName);
        if (postView?.type !== "oauth")
            return undefined;
        credential = postView;`,
    "resolve-oauth-post-view",
  );
  return preserveOAuthCredentialEnv(next);
}

function patchModelsLogin(sourceText) {
  let next = replaceOnce(
    sourceText,
    'import { ModelsError, resolveProviderAuth } from "./auth/resolve.js";\n',
    'import { ModelsError, resolveProviderAuth } from "./auth/resolve.js";\nimport { appendLoginSlot } from "./rubato-features/providers/auth-pool/slots.mjs";\n',
    "models-login-import",
  );
  return replaceOnce(
    next,
    `        const mutation = this.credentials.modify(providerId, async () => {
            mutationStarted = true;
            markMutationStarted?.();
            return credential;
        }, { signal });`,
    `        const mutation = this.credentials.modify(providerId, async (current) => {
            mutationStarted = true;
            markMutationStarted?.();
            return appendLoginSlot(current, credential);
        }, { signal });`,
    "models-login-append",
  );
}

function patchModelRuntimePool(sourceText) {
  let next = replaceOnce(
    sourceText,
    'import { RuntimeCredentials } from "./runtime-credentials.js";\n',
    'import { RuntimeCredentials } from "./runtime-credentials.js";\nimport { streamWithCredentialPool } from "../rubato-features/providers/auth-pool/runtime-pool.mjs";\n',
    "runtime-pool-import",
  );
  next = replaceOnce(
    next,
    `        const resolution = await this.getAuth(model, {
            apiKey: options?.apiKey,
            env: options?.env,
            signal: options?.signal,
        });`,
    `        const resolution = await this.getAuth(model, {
            apiKey: options?.apiKey,
            env: options?.env,
            signal: options?.signal,
            slotName: options?.slotName,
        });`,
    "runtime-slot-name",
  );
  next = replaceOnce(
    next,
    `    stream(model, context, options) {
        return lazyStream(model, async () => {
            const prepared = await this.prepareRequest(model, options);
            return prepared.provider.stream(prepared.model, context, prepared.options);
        });
    }`,
    `    stream(model, context, options) {
        return lazyStream(model, async () => streamWithCredentialPool(this, "stream", model, context, options));
    }`,
    "runtime-stream-pool",
  );
  return replaceOnce(
    next,
    `    streamSimple(model, context, options) {
        return lazyStream(model, async () => {
            const prepared = await this.prepareRequest(model, options);
            return prepared.provider.streamSimple(prepared.model, context, prepared.options);
        });
    }`,
    `    streamSimple(model, context, options) {
        return lazyStream(model, async () => streamWithCredentialPool(this, "streamSimple", model, context, options));
    }`,
    "runtime-stream-simple-pool",
  );
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
  "provider-ids.mjs",
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
    id: "providers:auth-resolve-pool",
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/auth/resolve.js",
    preimageSha256: "82ee45ecec319f59536759312a4de25313a8bb8cb7ce43db43d18edc10fef305",
    apply: patchResolveAuth,
  }),
  Object.freeze({
    id: "providers:models-login-append",
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/models.js",
    preimageSha256: "42610d47fe293d99f4b05b147971e181c7312ea47c9be2906a4803955276a8a4",
    apply: patchModelsLogin,
  }),
  Object.freeze({
    id: "providers:model-runtime-pool",
    packageName: "@earendil-works/pi-coding-agent",
    version: PACKAGE_VERSION,
    path: "dist/core/model-runtime.js",
    preimageSha256: "32cd50599d9e6e001229090e3d0554b60e4addb8ab7b3165635a574feb660b74",
    apply: patchModelRuntimePool,
  }),
]);

export const files = Object.freeze([
  ownedFile("dist/rubato-features/providers/extension.mjs", source("./extension.mjs")),
  ownedFile("dist/rubato-features/providers/src/engine-paths.mjs", source("./engine-paths.mjs")),
  ownedFile("dist/rubato-features/providers/cursor-lazy.mjs", source("./cursor-lazy.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/slots.mjs", source("./auth-pool/slots.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/select.mjs", source("./auth-pool/select.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/env-slots.mjs", source("./auth-pool/env-slots.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/classify.mjs", source("./auth-pool/classify.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/failover.mjs", source("./auth-pool/failover.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/state-store.mjs", source("./auth-pool/state-store.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/rotation-stream.mjs", source("./auth-pool/rotation-stream.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/accounts.mjs", source("./auth-pool/accounts.mjs")),
  ownedFile("dist/rubato-features/providers/auth-pool/runtime-pool.mjs", source("./auth-pool/runtime-pool.mjs")),
  codingAgentFile("dist/rubato-features/providers/auth-pool/runtime-pool.mjs", source("./auth-pool/coding-agent-runtime-pool.mjs")),
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
