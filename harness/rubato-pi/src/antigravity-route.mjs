/** Rubato Engine Antigravity provider, OAuth, and session-lineage ownership. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROJECT_ENV,
  createAntigravityApi,
} from "./antigravity-api.mjs";
export { ANTIGRAVITY_ENDPOINT } from "./antigravity-api.mjs";
import {
  ANTIGRAVITY_UNKNOWN_BRANCH,
  createAntigravityLineageTracker,
  createAntigravityStateStore,
} from "./antigravity-state.mjs";
import { defaultTargetAuthPath, resolveAgentDirFromEnv } from "./credential-import.mjs";
import { senpiNested } from "./engine-paths.mjs";
import { loginAntigravityGoogle } from "./antigravity-oauth-login.mjs";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
export const ANTIGRAVITY_OAUTH_FILE_ENV = "RUBATO_ANTIGRAVITY_OAUTH_FILE";
export const ANTIGRAVITY_ENDPOINT_ENV = "RUBATO_ANTIGRAVITY_ENDPOINT";

/** 삭제된 FX bridge 와 그 shadow. 직결 endpoint 가 여기를 가리키는 것은 언제나 잘못이다. */
const LEGACY_BRIDGE_PORTS = new Set(["8788", "18788"]);

const MODELS = Object.freeze([
  Object.freeze({ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextWindow: 200_000, maxTokens: 65_536 }),
  Object.freeze({ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 200_000, maxTokens: 65_536 }),
]);

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function antigravityModels() {
  return MODELS.map((entry) => ({
    ...entry,
    api: ANTIGRAVITY_API,
    provider: ANTIGRAVITY_PROVIDER_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: zeroCost(),
    compat: { supportsTemperature: false, supportsStrictTools: true },
  }));
}

function endpointFromEnv(env) {
  const configured = env?.[ANTIGRAVITY_ENDPOINT_ENV];
  if (typeof configured !== "string" || configured.length === 0) return ANTIGRAVITY_ENDPOINT;
  const url = new URL(configured);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Antigravity endpoint override must use HTTPS or loopback");
  }
  // loopback 허용이 삭제된 FX bridge 로 되돌아가는 문을 열어 두면 안 된다. 직결 provider 가
  // legacy gateway 형식으로 말하게 되고, 그것을 알아차릴 방법은 응답이 깨지는 것뿐이다.
  // 이 기기에서는 그 포트에 **다른 세션들이 쓰는 공유 bridge** 가 살아 있어 더 위험하다.
  if (LEGACY_BRIDGE_PORTS.has(url.port)) {
    throw new Error(`Antigravity endpoint override must not target the legacy bridge port ${url.port}`);
  }
  return url.href;
}

function oauthConfigPath(env = process.env, home = homedir()) {
  const explicit = env?.[ANTIGRAVITY_OAUTH_FILE_ENV];
  return typeof explicit === "string" && explicit.length > 0
    ? explicit
    : join(home, ".rubato-pi", "antigravity-oauth.json");
}

function oauthClients(env, readFileImpl) {
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(oauthConfigPath(env), "utf-8"));
  } catch {
    throw new Error("Antigravity OAuth client configuration is unavailable");
  }
  const source = Array.isArray(parsed?.clients) ? parsed.clients : [parsed];
  const clients = source.flatMap((entry) => {
    const id = entry?.id ?? entry?.client_id;
    const secret = entry?.secret ?? entry?.client_secret;
    return typeof id === "string" && typeof secret === "string" ? [{ id, secret }] : [];
  });
  if (clients.length === 0) throw new Error("Antigravity OAuth client configuration has no clients");
  return clients;
}

export async function loadAntigravityProjectId(access, endpoint, fetchImpl, signal) {
  const url = new URL(endpoint);
  url.pathname = "/v1internal:loadCodeAssist";
  url.search = "";
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      "content-type": "application/json",
      "user-agent": "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64)",
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal,
  });
  if (!response.ok) throw new Error(`Antigravity loadCodeAssist failed (${response.status})`);
  const data = await response.json();
  const project = data?.cloudaicompanionProject;
  if (typeof project !== "string" || project.length === 0) {
    throw new Error("Antigravity loadCodeAssist returned no project");
  }
  return project;
}

export function antigravityOAuth({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  endpoint = endpointFromEnv(env),
  loginGoogle = loginAntigravityGoogle,
} = {}) {
  const refresh = async (credential, signal) => {
    const clients = oauthClients(env, readFileImpl);
    let rotated;
    for (const client of clients) {
      const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: credential.refresh,
          grant_type: "refresh_token",
        }),
        signal,
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (typeof data.access_token !== "string" || data.access_token.length === 0) continue;
      rotated = {
        type: "oauth",
        access: data.access_token,
        refresh: typeof data.refresh_token === "string" ? data.refresh_token : credential.refresh,
        expires: Date.now() + (Number.isFinite(data.expires_in) ? data.expires_in : 3600) * 1000,
      };
      break;
    }
    if (!rotated) throw new Error("Antigravity OAuth refresh failed");

    const inheritedProject = credential.env?.[ANTIGRAVITY_PROJECT_ENV];
    const project = typeof inheritedProject === "string" && inheritedProject.length > 0
      ? inheritedProject
      : await loadAntigravityProjectId(rotated.access, endpoint, fetchImpl, signal);
    return { ...rotated, env: { [ANTIGRAVITY_PROJECT_ENV]: project } };
  };

  return {
    name: "Google Antigravity",
    isSubscription: true,
    loginLabel: "Sign in with Google",
    async login(interaction) {
      const clients = oauthClients(env, readFileImpl);
      const tokens = await loginGoogle({
        interaction,
        clients,
        fetchImpl,
      });
      const project = await loadAntigravityProjectId(tokens.access, endpoint, fetchImpl, interaction?.signal);
      return { ...tokens, env: { [ANTIGRAVITY_PROJECT_ENV]: project } };
    },
    refresh,
    async toAuth(credential) {
      if (typeof credential.access !== "string" || credential.access.length === 0) {
        throw new Error("Antigravity OAuth credential has no access token");
      }
      return { apiKey: credential.access };
    },
  };
}

function profileId(env) {
  return resolveAgentDirFromEnv(env) ?? defaultTargetAuthPath(homedir(), env);
}

function sessionId(options) {
  return typeof options?.sessionId === "string" && options.sessionId.length > 0
    ? options.sessionId
    : "no-session";
}

async function loadCreateProvider() {
  const module = await import(pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/models.js")).href);
  if (typeof module.createProvider !== "function") throw new Error("pinned pi-ai has no createProvider");
  return module.createProvider;
}

export async function antigravityDirectProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  createProvider,
  stateStore = createAntigravityStateStore(),
  lineage = createAntigravityLineageTracker(),
} = {}) {
  const factory = createProvider ?? await loadCreateProvider();
  const runStateful = async (options, fn) => {
    const sid = sessionId(options);
    const key = {
      profileId: profileId(env),
      providerId: ANTIGRAVITY_PROVIDER_ID,
      modelId: options?.antigravityModelId ?? "unknown",
      sessionId: sid,
      branchId: lineage.branchOf(sid),
      conversationGeneration: lineage.generationOf(sid),
    };
    try {
      const settled = await stateStore.run(key, fn, { signal: options?.signal });
      // throw 를 기다리면 안 된다. `AssistantMessageEventStream` 은 error event 를
      // **reject 가 아니라 resolve** 로 정착시키므로(`pi-ai/dist/utils/event-stream.js`
      // 의 final-result 변환) 오류·abort turn 도 `fn` 이 정상 반환한다. 그때 state 를
      // 남기면 `lastExecutionId`/`stepIndex` 가 상류가 받지도 않은 step 을 가리키고,
      // 다음 turn 이 그 자리에서 이어진다. 오염된 lineage 는 여기서 닫는다.
      if (settled?.stopReason === "error" || settled?.stopReason === "aborted") stateStore.drop(key);
      return settled;
    } catch (error) {
      stateStore.drop(key);
      throw error;
    }
  };
  const transport = createAntigravityApi({ fetchImpl, endpoint: endpointFromEnv(env), runStateful });
  const withModelId = {
    stream: (model, context, options) => transport.stream(model, context, { ...options, antigravityModelId: model.id }),
    streamSimple: (model, context, options) => transport.streamSimple(model, context, { ...options, antigravityModelId: model.id }),
  };
  const provider = factory({
    id: ANTIGRAVITY_PROVIDER_ID,
    name: "Google Antigravity",
    baseUrl: endpointFromEnv(env),
    auth: { oauth: antigravityOAuth({ env, fetchImpl, readFileImpl, endpoint: endpointFromEnv(env) }) },
    models: antigravityModels(),
    api: withModelId,
  });
  return { provider, stateStore, lineage };
}

export function registerAntigravityLifecycle(pi, {
  stateStore,
  lineage,
  env = process.env,
  profileId: explicitProfileId,
} = {}) {
  if (!stateStore || !lineage || typeof pi?.on !== "function") return;
  let activeSessionId;
  const stateProfileId = explicitProfileId ?? profileId(env);

  const identify = (ctx) => {
    const sid = ctx?.sessionManager?.getSessionId?.();
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    const sid = identify(ctx);
    if (!sid) return;
    activeSessionId = sid;
    lineage.seed(sid, ctx.sessionManager.getLeafId?.() ?? ANTIGRAVITY_UNKNOWN_BRANCH);
  });
  pi.on("session_tree", (event, ctx) => {
    const sid = identify(ctx) ?? activeSessionId;
    if (!sid) return;
    stateStore.dropSession({ profileId: stateProfileId, sessionId: sid });
    lineage.onTree(sid, event.newLeafId);
  });
  pi.on("session_compact", (event, ctx) => {
    if (!event.accepted) return;
    const sid = identify(ctx) ?? activeSessionId;
    if (!sid) return;
    stateStore.dropSession({ profileId: stateProfileId, sessionId: sid });
    lineage.onGenerationChange(sid);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sid = identify(ctx) ?? activeSessionId;
    if (!sid) return;
    stateStore.dropSession({ profileId: stateProfileId, sessionId: sid });
    lineage.forget(sid);
    if (activeSessionId === sid) activeSessionId = undefined;
  });
  pi.on("session_extensions_removed", () => {
    stateStore.clear();
    lineage.clear();
    activeSessionId = undefined;
  });
}
