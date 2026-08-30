import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROVIDER_ID,
  antigravityDirectProvider,
  antigravityModels,
  antigravityOAuth,
  loadAntigravityProjectId,
  registerAntigravityLifecycle,
} from "../../src/antigravity-route.mjs";
import { createAntigravityLineageTracker } from "../../src/antigravity-state.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";

const { resolveProviderAuth } = await import(
  pathToFileURL(join(senpiNested("@earendil-works/pi-ai"), "dist/auth/resolve.js")).href
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function response(json, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => json };
}

test("loadCodeAssist는 endpoint origin에 project를 묻는다", async () => {
  let seen;
  const project = await loadAntigravityProjectId("access", "http://127.0.0.1:18789/custom", async (url, init) => {
    seen = { url: String(url), init };
    return response({ cloudaicompanionProject: "project-a" });
  });
  assert.equal(project, "project-a");
  assert.equal(seen.url, "http://127.0.0.1:18789/v1internal:loadCodeAssist");
  assert.equal(seen.init.headers.authorization, "Bearer access");
});

function oauthClientsFile(clients = [{ id: "client", secret: "secret" }]) {
  const readFileImpl = (...args) => {
    readFileImpl.calls.push(args);
    return JSON.stringify({ clients });
  };
  readFileImpl.calls = [];
  return readFileImpl;
}

test("OAuth refresh는 token rotation과 project env를 한 credential로 돌려준다", async () => {
  const calls = [];
  const readFileImpl = oauthClientsFile();
  const oauth = antigravityOAuth({
    env: {},
    readFileImpl,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return response({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 });
      }
      return response({ cloudaicompanionProject: "project-a" });
    },
  });
  const rotated = await oauth.refresh({ refresh: "old-refresh" });
  assert.equal(rotated.access, "next-access");
  assert.equal(rotated.refresh, "next-refresh");
  assert.equal(rotated.env.RUBATO_ANTIGRAVITY_PROJECT, "project-a");
  assert.deepEqual(await oauth.toAuth(rotated), { apiKey: "next-access" });
  assert.equal(calls.length, 2);
  assert.equal(readFileImpl.calls.length, 1, "refresh가 주입한 client file을 읽지 않았다");
});

test("OAuth refresh가 project를 못 받으면 credential을 만들지 않는다", async () => {
  const readFileImpl = oauthClientsFile();
  const oauth = antigravityOAuth({
    env: {},
    readFileImpl,
    fetchImpl: async (url) => String(url).includes("oauth2.googleapis.com/token")
      ? response({ access_token: "next", expires_in: 3600 })
      : response({}),
  });
  await assert.rejects(oauth.refresh({ refresh: "old" }), /returned no project/);
  assert.equal(readFileImpl.calls.length, 1, "refresh가 주입한 client file을 읽지 않았다");
});

test("login은 Google OAuth 뒤에 project를 붙여 credential을 돌려준다", async () => {
  const events = [];
  const oauth = antigravityOAuth({
    env: {},
    readFileImpl: oauthClientsFile(),
    fetchImpl: async (url) => {
      if (String(url).includes("v1internal:loadCodeAssist")) {
        return response({ cloudaicompanionProject: "project-a" });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    loginGoogle: async ({ interaction, clients }) => {
      assert.equal(clients.length, 1);
      interaction.notify({ type: "auth_url", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client" });
      return { type: "oauth", access: "ak", refresh: "rk", expires: Date.now() + 60_000 };
    },
  });
  const credential = await oauth.login({
    notify: (event) => events.push(event),
    prompt: async () => { throw new Error("login must not fall back to text input"); },
  });
  assert.equal(events[0]?.type, "auth_url");
  assert.match(events[0].url, /accounts\.google\.com/);
  assert.equal(credential.access, "ak");
  assert.equal(credential.env.RUBATO_ANTIGRAVITY_PROJECT, "project-a");
});

test("provider endpoint는 HTTPS와 loopback만 허용한다", async () => {
  const factory = (definition) => definition;
  await assert.rejects(
    antigravityDirectProvider({
      env: { RUBATO_ANTIGRAVITY_ENDPOINT: "http://example.com/leak" }, createProvider: factory,
    }),
    /must use HTTPS or loopback/,
  );
  const local = await antigravityDirectProvider({
    env: { RUBATO_ANTIGRAVITY_ENDPOINT: "http://127.0.0.1:18888/custom" }, createProvider: factory,
  });
  assert.equal(local.provider.baseUrl, "http://127.0.0.1:18888/custom");
});

test("오류로 끝난 turn은 오염된 lineage state를 버린다", async () => {
  // `result()` 는 error event 를 **reject 가 아니라 resolve** 로 돌려준다
  // (`pi-ai/dist/utils/event-stream.js` 의 `AssistantMessageEventStream`). 그래서
  // `runStateful` 이 throw 를 기다리면 오류 turn 의 `lastExecutionId`/`stepIndex` 가
  // 그대로 남고, 다음 turn 이 상류가 받지도 않은 step 에서 이어진다.
  const dropped = [];
  const provider = await antigravityDirectProvider({
    env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" },
    createProvider: (definition) => definition,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "failed" }),
    stateStore: {
      run: async (_key, fn) => fn({ sessionId: "wire-session", stepIndex: 1 }),
      drop: (key) => dropped.push(key),
    },
    lineage: { branchOf: () => "leaf-a", generationOf: () => 0 },
  });
  const stream = provider.provider.api.stream(
    antigravityModels()[0],
    { messages: [] },
    { apiKey: "token", env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" }, sessionId: "session-a" },
  );
  for await (const _event of stream) { /* drain */ }
  const settled = await stream.result();
  await tick(); // drop 은 stream 정착 뒤 같은 turn 의 다음 tick 에 일어난다
  assert.equal(settled.stopReason, "error");
  assert.equal(dropped.length, 1, "오류 turn 은 state 를 버려야 한다");
  assert.equal(dropped[0].sessionId, "session-a");
  assert.equal(dropped[0].branchId, "leaf-a");
});

test("abort로 끝난 turn도 오염된 lineage state를 버린다", async () => {
  const dropped = [];
  const controller = new AbortController();
  const provider = await antigravityDirectProvider({
    env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" },
    createProvider: (definition) => definition,
    fetchImpl: async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
    stateStore: {
      run: async (_key, fn) => fn({ sessionId: "wire-session", stepIndex: 1 }),
      drop: (key) => dropped.push(key),
    },
    lineage: { branchOf: () => "leaf-a", generationOf: () => 0 },
  });
  const stream = provider.provider.api.stream(
    antigravityModels()[0],
    { messages: [] },
    { apiKey: "token", env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" }, sessionId: "session-a", signal: controller.signal },
  );
  for await (const _event of stream) { /* drain */ }
  assert.equal((await stream.result()).stopReason, "aborted");
  await tick();
  assert.equal(dropped.length, 1, "abort turn 은 state 를 버려야 한다");
});

test("정상 turn은 lineage state를 버리지 않는다", async () => {
  const dropped = [];
  const chunk = `data: ${JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      responseId: "exec-1",
    },
  })}\r\n\r\n`;
  const provider = await antigravityDirectProvider({
    env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" },
    createProvider: (definition) => definition,
    fetchImpl: async () => ({
      ok: true,
      body: (async function* () { yield new TextEncoder().encode(chunk); })(),
    }),
    stateStore: {
      run: async (_key, fn) => fn({ sessionId: "wire-session", stepIndex: 1 }),
      drop: (key) => dropped.push(key),
    },
    lineage: { branchOf: () => "leaf-a", generationOf: () => 0 },
  });
  const stream = provider.provider.api.stream(
    antigravityModels()[0],
    { messages: [] },
    { apiKey: "token", env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" }, sessionId: "session-a" },
  );
  for await (const _event of stream) { /* drain */ }
  assert.equal((await stream.result()).stopReason, "stop");
  await tick();
  assert.deepEqual(dropped, [], "정상 turn 의 continuation state 를 버리면 3턴 이어짐이 깨진다");
});

test("lifecycle은 start/tree/accepted compact/shutdown을 state store와 lineage에 반영한다", async () => {
  const handlers = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  const calls = [];
  const lineage = {
    seed: (...args) => calls.push(["seed", ...args]),
    onTree: (...args) => calls.push(["tree", ...args]),
    onGenerationChange: (...args) => calls.push(["generation", ...args]),
    forget: (...args) => calls.push(["drop", ...args]),
    clear: () => calls.push(["clear"]),
  };
  const stateStore = {
    dropSession: (...args) => calls.push(["dropSession", ...args]),
    clear: () => calls.push(["storeClear"]),
  };
  const sessionManager = { getSessionId: () => "session-a", getLeafId: () => "leaf-a" };
  registerAntigravityLifecycle(pi, {
    stateStore,
    lineage,
    profileId: "/profile",
  });
  const ctx = { sessionManager };
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_tree")({ newLeafId: "leaf-b" }, ctx);
  await handlers.get("session_compact")({ accepted: false }, ctx);
  await handlers.get("session_compact")({ accepted: true }, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  await handlers.get("session_extensions_removed")({}, {});

  assert.deepEqual(calls, [
    ["seed", "session-a", "leaf-a"],
    ["dropSession", { profileId: "/profile", sessionId: "session-a" }], ["tree", "session-a", "leaf-b"],
    ["dropSession", { profileId: "/profile", sessionId: "session-a" }], ["generation", "session-a"],
    ["dropSession", { profileId: "/profile", sessionId: "session-a" }], ["drop", "session-a"],
    ["storeClear"], ["clear"],
  ]);
});

// Design: "state key는 {profileId, providerId, modelId, sessionId, branchId, conversationGeneration}이다."
test("stream이 넘기는 state key는 profile·provider·model·session·branch·generation이다", async () => {
  const keys = [];
  const lineage = createAntigravityLineageTracker();
  lineage.seed("session-a", "leaf-seeded");
  const provider = await antigravityDirectProvider({
    env: { RUBATO_PI_CODING_AGENT_DIR: "/tmp/rubato-antigravity-route-key" },
    createProvider: (definition) => definition,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "failed" }),
    stateStore: {
      run: async (key, fn) => {
        keys.push(key);
        return fn({ sessionId: "wire-session", stepIndex: 1 });
      },
      drop: () => {},
    },
    lineage,
  });
  const stream = provider.provider.api.stream(
    antigravityModels()[0],
    { messages: [] },
    { apiKey: "token", env: { RUBATO_ANTIGRAVITY_PROJECT: "project-a" }, sessionId: "session-a" },
  );
  for await (const _event of stream) { /* drain */ }
  await stream.result();
  await tick();
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0], {
    profileId: "/tmp/rubato-antigravity-route-key",
    providerId: ANTIGRAVITY_PROVIDER_ID,
    modelId: antigravityModels()[0].id,
    sessionId: "session-a",
    branchId: "leaf-seeded",
    conversationGeneration: 0,
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function lockingCredentialStore(initial, { onQueued } = {}) {
  const credentials = new Map([[ANTIGRAVITY_PROVIDER_ID, initial]]);
  let chain = Promise.resolve();
  let queued = 0;
  return {
    async read(providerId) {
      return credentials.get(providerId);
    },
    async list() {
      return [...credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn, options) {
      queued += 1;
      onQueued?.(queued);
      const run = chain.then(async () => {
        options?.signal?.throwIfAborted?.();
        const current = credentials.get(providerId);
        const next = await fn(current);
        options?.signal?.throwIfAborted?.();
        if (next !== undefined) credentials.set(providerId, next);
        return next ?? current;
      });
      chain = run.catch(() => {});
      return run;
    },
    delete(providerId) {
      const run = chain.then(() => { credentials.delete(providerId); });
      chain = run.catch(() => {});
      return run;
    },
  };
}

// Design: "두 프로세스가 같은 만료 credential을 요청해도 lock 안에서 재확인하여 원격 refresh가 한 번만 일어나고 나머지는 새 credential을 읽는다."
test("만료 credential의 겹친 resolveStoredOAuth는 lock 안에서 token을 한 번만 친다", async () => {
  const holdRefresh = deferred();
  let tokenCalls = 0;
  const oauth = antigravityOAuth({
    env: {},
    readFileImpl: oauthClientsFile(),
    fetchImpl: async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        tokenCalls += 1;
        await holdRefresh.promise;
        return response({ access_token: "next-access", expires_in: 3600 });
      }
      return response({ cloudaicompanionProject: "project-a" });
    },
  });
  const expired = {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1,
  };
  const secondQueued = deferred();
  const credentials = lockingCredentialStore(expired, {
    onQueued: (count) => { if (count === 2) secondQueued.resolve(); },
  });
  const provider = { id: ANTIGRAVITY_PROVIDER_ID, auth: { oauth } };
  const authContext = { env: async () => undefined, fileExists: async () => false };

  const first = resolveProviderAuth(provider, credentials, authContext);
  const second = resolveProviderAuth(provider, credentials, authContext);
  await secondQueued.promise;
  holdRefresh.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(tokenCalls, 1, "lock 재확인이 없어 token refresh가 두 번 나갔다");
  assert.equal(a.auth.apiKey, "next-access");
  assert.equal(b.auth.apiKey, "next-access");
  assert.equal((await credentials.read(ANTIGRAVITY_PROVIDER_ID)).access, "next-access");
});
