// Cursor 직결 경로: catalog 공개가 활성화 canary 뒤에 오는가.
//
// 전부 offline 이다. auth/catalog/Run/HTTP2 는 주입한 seam 으로 대체하고, 실제
// 자격증명 파일도 vendor 주소도 건드리지 않는다. 그런데 **판정 축은 pinned 것을 쓴다**:
// gate 는 pinned `createProvider` 가 만든 `refreshModels` 를 감싸고, header 판정은
// pinned `sanitizeCursorCallerHeaders` 를 그대로 부른다. 우리가 상상한 provider 를
// 검사하면 실제 등록에서 터지는 지점을 못 본다.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  CURSOR_ACTIVATION_MARKER_FILE,
  CURSOR_ACTIVATION_MARKER_VERSION,
  CURSOR_ACTIVATION_TTL_MS,
  CURSOR_CANARY_SESSION_PREFIX,
  CURSOR_FALLBACK_ELIGIBLE_KINDS,
  CURSOR_HTTP2_REQUIRED_MESSAGE,
  CursorCanaryError,
  cursorAccessToken,
  cursorActivationMarkerPath,
  cursorCanarySessionId,
  cursorCatalogGeneration,
  cursorCredentialGeneration,
  cursorDirectProvider,
  cursorTerminalFailure,
  fileActivationMarkerStore,
  isCursorHttp2Failure,
  issueCursorActivationMarker,
  rewriteCursorHttp2Error,
  runCursorCanary,
  verifyCursorActivationMarker,
  withCursorActivationCanary,
} from "../../src/cursor-route.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";

const piAi = (...segments) => pathToFileURL(join(senpiNested("@earendil-works/pi-ai"), ...segments)).href;
const { createProvider } = await import(piAi("dist/index.js"));
const cursorAgent = await import(piAi("dist/api/cursor-agent.js"));

// 값은 sentinel 이다. 한 글자짜리 token 을 쓰면 "증명에 값이 실렸나" 판정이 JSON 의
// 다른 글자와 우연히 겹쳐 무의미해진다.
const CREDENTIAL = Object.freeze({
  type: "oauth",
  access: "SENTINEL-CURSOR-ACCESS",
  refresh: "SENTINEL-CURSOR-REFRESH",
  expires: 4_102_444_800_000,
});

function discoveredModel(id) {
  return { id, name: id, api: "cursor-agent", provider: "cursor", baseUrl: "https://api2.cursor.sh" };
}

/** pinned createProvider 로 만든 Cursor 대역. fetchModels 만 주입한다 — vendor 호출은 없다. */
function pinnedShapedCursor({ fetchModels, stream = () => { throw new Error("stream must not run"); } } = {}) {
  return createProvider({
    id: "cursor",
    name: "Cursor",
    baseUrl: "https://api2.cursor.sh",
    models: [],
    fetchModels,
    api: { stream, streamSimple: stream },
  });
}

/** 메모리 marker store. 실제 profile 경로를 절대 건드리지 않는다. */
function memoryMarkerStore(initial = undefined) {
  let text = initial;
  return {
    read: () => text,
    write: (next) => { text = next; },
    get text() { return text; },
    set text(next) { text = next; },
  };
}

/** pinned refreshModels 가 실제로 받는 모양의 context. publish 는 공개된 목록을 기록한다. */
function refreshContext({ stored, allowNetwork = true, publishResult = true } = {}) {
  const published = [];
  return {
    published,
    context: {
      credential: CREDENTIAL,
      stored,
      allowNetwork,
      signal: AbortSignal.any([]),
      publish: async (publication) => {
        published.push(publication);
        // pinned host 가 하는 일을 그대로 한다(`models.js` publishProviderModels): 공개가
        // 허욠되면 `update()` 를 부른다. 이것을 안 부르면 `getModels()` 는 항상
        // 바어 보여 테스트가 거짓으로 통과한다.
        if (publishResult) publication.update?.();
        return publishResult;
      },
    },
  };
}

test("canary 성공: 발견한 모델이 정규화된 채로 공개된다", async () => {
  const runs = [];
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1"), discoveredModel("gpt-5.6")] }),
    {
      markerStore: memoryMarkerStore(),
      run: async ({ model, sessionId, credential }) => {
        runs.push({ modelId: model.id, sessionId, token: cursorAccessToken(credential) });
        return { stopReason: "stop", content: [] };
      },
    },
  );
  const { context, published } = refreshContext();
  await provider.refreshModels(context);

  assert.equal(runs.length, 1, "canary Run 은 정확히 한 번이다");
  assert.equal(runs[0].modelId, "composer-1", "canary 모델은 발견 목록에서 고른다");
  assert.equal(runs[0].token, CREDENTIAL.access, "canary 는 access token 으로 나간다");
  assert.equal(published.length, 1, "성공하면 공개는 한 번");
  assert.deepEqual(published[0].persist.models.map((model) => model.id), ["composer-1", "gpt-5.6"]);
  assert.deepEqual(provider.getModels().map((model) => model.id), ["composer-1", "gpt-5.6"]);
});

test("canary 세션은 사용자 세션과 겹치지 않는 고유 id 다", async () => {
  const seen = [];
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    {
      markerStore: memoryMarkerStore(),
      run: async ({ sessionId }) => {
        seen.push(sessionId);
        return { stopReason: "stop" };
      },
    },
  );
  await provider.refreshModels(refreshContext().context);
  assert.match(seen[0], new RegExp(`^${CURSOR_CANARY_SESSION_PREFIX}`), "canary 세션 접두가 없으면 사용자 checkpoint 를 오염시킨다");
  assert.notEqual(cursorCanarySessionId(), cursorCanarySessionId(), "두 canary 가 같은 세션을 쓰면 안 된다");
});

test("주입한 sessionId 가 canary 접두를 갖지 않으면 아예 돌리지 않는다", async () => {
  let ran = false;
  await assert.rejects(
    () => runCursorCanary({
      provider: {},
      models: [discoveredModel("composer-1")],
      credential: CREDENTIAL,
      sessionId: "user-session-42",
      run: async () => { ran = true; return { stopReason: "stop" }; },
    }),
    (error) => error instanceof CursorCanaryError,
  );
  assert.equal(ran, false, "사용자 세션 id 로 canary 를 돌리면 실제 대화를 오염시킨다");
});

test("fail closed: 각 종료 종류가 공개도 fallback 도 만들지 않는다", async () => {
  const cases = [
    { kind: "auth", eligible: false },
    { kind: "oauth", eligible: false },
    { kind: "cancelled", eligible: false },
    { kind: "content", eligible: false },
    { kind: "unknown", eligible: false },
    { kind: "transport", eligible: true },
    { kind: "protocol", eligible: true },
  ];
  for (const testCase of cases) {
    const provider = withCursorActivationCanary(
      pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
      {
        markerStore: memoryMarkerStore(),
        run: async () => ({
          stopReason: "error",
          errorMessage: "terminal",
          cursorFailure: { kind: testCase.kind, fallbackEligible: testCase.eligible },
        }),
      },
    );
    const { context, published } = refreshContext();
    await assert.rejects(
      () => provider.refreshModels(context),
      (error) => {
        assert.ok(error instanceof CursorCanaryError, `${testCase.kind}: canary 오류가 아니다`);
        assert.equal(error.reason, testCase.kind);
        assert.equal(error.fallbackEligible, testCase.eligible, `${testCase.kind}: fallback 판정이 다르다`);
        return true;
      },
    );
    assert.deepEqual(published, [], `${testCase.kind}: 실패했는데 공개했다`);
    assert.deepEqual(provider.getModels(), [], `${testCase.kind}: 실패했는데 모델이 보인다`);
  }
  // 그리고 이 leg 에서는 어느 실패도 실제로 다른 경로로 나가지 않는다.
  assert.deepEqual([...CURSOR_FALLBACK_ELIGIBLE_KINDS], ["transport", "protocol"]);
});

test("신뢰할 catalog 가 없으면 Run 을 돌리지도 않는다", async () => {
  let ran = false;
  const provider = withCursorActivationCanary(
    // discovery 가 빈 목록이면 pinned refreshModels 는 publish 조차 하지 않는다.
    pinnedShapedCursor({ fetchModels: async () => [] }),
    { markerStore: memoryMarkerStore(), run: async () => { ran = true; return { stopReason: "stop" }; } },
  );
  const { context, published } = refreshContext();
  await provider.refreshModels(context);
  assert.equal(ran, false, "catalog 가 없는데 Run 을 보냈다");
  assert.deepEqual(published, []);

  // 저장분도 목록도 없이 gate 를 직접 부르면 사유가 분명해야 한다.
  await assert.rejects(
    () => runCursorCanary({ provider: {}, models: [], credential: CREDENTIAL, run: async () => ({ stopReason: "stop" }) }),
    (error) => error.reason === "no_trusted_catalog",
  );
});

test("자격증명이 없으면 Run 을 돌리지 않고 사유를 남긴다", async () => {
  let ran = false;
  await assert.rejects(
    () => runCursorCanary({
      provider: {},
      models: [discoveredModel("composer-1")],
      credential: undefined,
      run: async () => { ran = true; return { stopReason: "stop" }; },
    }),
    (error) => error.reason === "no_credential",
  );
  assert.equal(ran, false);
});

test("single-flight: refresh 가 겹쳐도 Run 은 한 번만 나간다", async () => {
  let runs = 0;
  let release;
  const gateOpen = new Promise((resolve) => { release = resolve; });
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    {
      markerStore: memoryMarkerStore(),
      run: async () => {
        runs += 1;
        // 시간에 기대지 않는다. 두 refresh 가 모두 gate 안에 들어온 것을 확인한 뒤 푼다.
        await gateOpen;
        return { stopReason: "stop" };
      },
    },
  );
  const first = refreshContext();
  const second = refreshContext();
  const inflight = [provider.refreshModels(first.context), provider.refreshModels(second.context)];
  // 두 호출이 canary 에 도달할 때까지 microtask 를 흘린다 — sleep 이 아니다.
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
  release();
  await Promise.all(inflight);
  assert.equal(runs, 1, `canary Run 이 ${runs} 번 나갔다`);
  assert.equal(first.published.length, 1);
  assert.equal(second.published.length, 1);
});

// -------------------------------------------------- 두 phase 활성화 (offline)

/**
 * pinned `ModelsImpl.refresh` 를 그대로 흉내낸다(`models.js:83-95`).
 *
 * 이 순서가 이 leg 의 결함이 살던 자리다: 복원 phase 는 자격증명 해결 **전에**, 무조건
 * 돈다. 그래서 테스트도 그 순서를 그대로 재현해야 한다 — network phase 만 부르면 결함이
 * 테스트에 보이지 않는다.
 */
async function twoPhaseRefresh(provider, { store, storedCredential, resolvedCredential = storedCredential, allowNetwork = true, publishResult = true }) {
  const published = [];
  const phases = [];
  const publish = async (publication) => {
    published.push(publication);
    if (publishResult) publication.update?.();
    return publishResult;
  };
  const context = (credential, network) => ({
    credential,
    // 호스트는 두 phase 모두 같은 저장분을 읽는다.
    stored: store ? structuredClone(store) : undefined,
    allowNetwork: network,
    signal: AbortSignal.any([]),
    publish: async (publication) => {
      phases.push(network ? "network" : "restore");
      return await publish(publication);
    },
  });
  // 1) 복원 phase — 자격증명 해결 전, allowNetwork:false.
  await provider.refreshModels(context(storedCredential, false));
  // 2) 발견 phase — 해결된 자격증명, allowNetwork:true.
  if (allowNetwork) await provider.refreshModels(context(resolvedCredential, true));
  return { published, phases };
}

test("두 phase: 활성화 증명이 없는 부모는 저장분을 복원 phase 에서 공개하지 않는다", async () => {
  // 이것이 lead 가 찾은 경쟁이다. 복원 phase 는 canary 보다 먼저 돌고, 그것을 그냥
  // 통과시키면 두 번째 세션부터 gate 가 무의미해진다.
  const decisions = [];
  const store = memoryMarkerStore();
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => { throw new Error("discovery must not run"); } }),
    { markerStore: store, onDecision: (decision) => decisions.push(decision), run: async () => ({ stopReason: "stop" }) },
  );
  const { published } = await twoPhaseRefresh(provider, {
    store: { models: [discoveredModel("composer-1")], checkedAt: 1 },
    storedCredential: CREDENTIAL,
    allowNetwork: false,
  });
  assert.deepEqual(published, [], "canary 전에 저장분이 공개됐다");
  assert.deepEqual(provider.getModels(), [], "canary 전에 모델이 보인다");
  // 거절된 복원은 보수적 경계를 함께 세운다: 재시작 이전 세션은 실행하지 않는다.
  assert.deepEqual(decisions, [{
    ok: false, phase: "restore", reason: "absent", conservativeBoundary: true, fallbackEligible: false,
  }]);
});

test("두 phase: 발견 + Run 성공이 증명을 확정하고 공개한다", async () => {
  const store = memoryMarkerStore();
  const decisions = [];
  let runs = 0;
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1"), discoveredModel("gpt-5.6")] }),
    {
      markerStore: store,
      onDecision: (decision) => decisions.push(decision),
      run: async () => { runs += 1; return { stopReason: "stop" }; },
    },
  );
  const { published, phases } = await twoPhaseRefresh(provider, { storedCredential: CREDENTIAL });
  assert.equal(runs, 1, "두 phase 를 다 돌려도 Run 은 한 번이다");
  // 복원 phase 는 저장분이 없어 publish 자체가 없었고, 발견 phase 만 공개했다.
  assert.deepEqual(phases, ["network"]);
  assert.equal(published.length, 1);
  assert.deepEqual(provider.getModels().map((model) => model.id), ["composer-1", "gpt-5.6"]);
  // 증명이 남았고, 그 증명은 지금의 자격증명·catalog 에 묶여 있다.
  const marker = JSON.parse(store.text);
  assert.equal(marker.version, CURSOR_ACTIVATION_MARKER_VERSION);
  assert.equal(marker.provider, "cursor");
  assert.equal(marker.modelCount, 2);
  assert.ok(!JSON.stringify(marker).includes(CREDENTIAL.refresh), "증명에 refresh token 이 실렸다");
  assert.ok(!JSON.stringify(marker).includes(CREDENTIAL.access), "증명에 access token 이 실렸다");
  assert.ok(decisions.some((decision) => decision.ok === true && decision.phase === "activate"));
});

test("두 phase: 부모 증명을 상속한 자식은 offline 으로 저장분을 복원한다", async () => {
  // 부모가 활성화한다.
  const store = memoryMarkerStore();
  const parent = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    { markerStore: store, run: async () => ({ stopReason: "stop" }) },
  );
  const parentRun = await twoPhaseRefresh(parent, { storedCredential: CREDENTIAL });
  const persisted = parentRun.published.at(-1).persist;
  assert.ok(persisted, "부모가 저장분을 남기지 않았다");

  // 자식은 같은 profile 을 물려받되 network 를 쓰지 않고 Run 도 하지 않는다.
  let childRuns = 0;
  const decisions = [];
  const child = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => { throw new Error("child must not discover"); } }),
    {
      markerStore: memoryMarkerStore(store.text),
      onDecision: (decision) => decisions.push(decision),
      run: async () => { childRuns += 1; return { stopReason: "stop" }; },
    },
  );
  const { published } = await twoPhaseRefresh(child, {
    store: persisted,
    storedCredential: CREDENTIAL,
    allowNetwork: false,
  });
  assert.equal(childRuns, 0, "격리 agent 마다 vendor canary 가 생기면 안 된다");
  assert.equal(published.length, 1, "상속된 증명이 있는데 복원하지 못했다");
  assert.deepEqual(child.getModels().map((model) => model.id), ["composer-1"]);
  assert.deepEqual(decisions, [{ ok: true, phase: "restore", inherited: true, route: "native" }]);
});

test("증명은 정적 활성화가 되지 않는다: 자격증명·catalog 세대에 묶인다", async () => {
  const store = memoryMarkerStore();
  const parent = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    { markerStore: store, run: async () => ({ stopReason: "stop" }) },
  );
  const parentRun = await twoPhaseRefresh(parent, { storedCredential: CREDENTIAL });
  const persisted = parentRun.published.at(-1).persist;
  const issued = store.text;

  const child = (marker) => {
    const decisions = [];
    return {
      decisions,
      provider: withCursorActivationCanary(
        pinnedShapedCursor({ fetchModels: async () => { throw new Error("child must not discover"); } }),
        {
          markerStore: memoryMarkerStore(marker),
          onDecision: (decision) => decisions.push(decision),
          run: async () => { throw new Error("child must not run a canary"); },
        },
      ),
    };
  };

  const cases = [
    {
      label: "다시 로그인해 refresh token 이 바뀌었다",
      marker: issued,
      store: persisted,
      credential: { ...CREDENTIAL, refresh: "a-different-login" },
      reason: "credential_generation_mismatch",
    },
    {
      label: "access token 만 갱신됐다면 증명은 살아 있어야 한다",
      marker: issued,
      store: persisted,
      credential: { ...CREDENTIAL, access: "rotated-access", expires: CREDENTIAL.expires + 1 },
      reason: undefined,
    },
    {
      label: "저장 catalog 가 증명된 목록과 다르다",
      marker: issued,
      store: { models: [discoveredModel("composer-1"), discoveredModel("smuggled-model")], checkedAt: 2 },
      credential: CREDENTIAL,
      reason: "catalog_generation_mismatch",
    },
    {
      label: "위조: 필드를 그럴듯하게 손으로 적었다",
      marker: JSON.stringify({
        version: CURSOR_ACTIVATION_MARKER_VERSION,
        provider: "cursor",
        issuedAt: Date.now(),
        salt: "forged-salt",
        credentialGeneration: "forged",
        catalogGeneration: "forged",
        modelCount: 1,
      }),
      store: persisted,
      credential: CREDENTIAL,
      reason: "credential_generation_mismatch",
    },
    { label: "위조: JSON 이 아니다", marker: "not json", store: persisted, credential: CREDENTIAL, reason: "unreadable" },
    { label: "위조: 배열이다", marker: "[]", store: persisted, credential: CREDENTIAL, reason: "malformed" },
    {
      label: "다른 provider 의 증명을 재사용했다",
      marker: JSON.stringify({ ...JSON.parse(issued), provider: "openai-codex" }),
      store: persisted,
      credential: CREDENTIAL,
      reason: "provider_mismatch",
    },
    {
      label: "다음 schema 의 증명을 이번 판정이 받아들이지 않는다",
      marker: JSON.stringify({ ...JSON.parse(issued), version: CURSOR_ACTIVATION_MARKER_VERSION + 1 }),
      store: persisted,
      credential: CREDENTIAL,
      reason: "version_mismatch",
    },
    {
      label: "오래된 증명",
      marker: JSON.stringify({ ...JSON.parse(issued), issuedAt: Date.now() - CURSOR_ACTIVATION_TTL_MS - 1 }),
      store: persisted,
      credential: CREDENTIAL,
      reason: "expired",
    },
    {
      label: "시계가 뒤로 간 프로필의 미래 증명",
      marker: JSON.stringify({ ...JSON.parse(issued), issuedAt: Date.now() + 60_000 }),
      store: persisted,
      credential: CREDENTIAL,
      reason: "expired",
    },
  ];

  for (const testCase of cases) {
    const { provider, decisions } = child(testCase.marker);
    const { published } = await twoPhaseRefresh(provider, {
      store: testCase.store,
      storedCredential: testCase.credential,
      allowNetwork: false,
    });
    if (testCase.reason === undefined) {
      assert.equal(published.length, 1, `${testCase.label}: 복원돼야 하는데 막혔다`);
      assert.deepEqual(decisions, [{ ok: true, phase: "restore", inherited: true, route: "native" }], testCase.label);
      continue;
    }
    assert.deepEqual(published, [], `${testCase.label}: 공개됐다`);
    assert.deepEqual(provider.getModels(), [], `${testCase.label}: 모델이 보인다`);
    assert.deepEqual(
      decisions,
      [{ ok: false, phase: "restore", reason: testCase.reason, conservativeBoundary: true, fallbackEligible: false }],
      testCase.label,
    );
  }
});

test("부모는 재로그인 뒤 오프라인 동기화에서 canary를 다시 돈다", async () => {
  const store = memoryMarkerStore();
  const parent = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    { markerStore: store, run: async () => ({ stopReason: "stop" }) },
  );
  const first = await twoPhaseRefresh(parent, { storedCredential: CREDENTIAL });
  const persisted = first.published.at(-1).persist;
  const previousMarker = store.text;
  const rotated = { ...CREDENTIAL, refresh: "after-relogin" };
  let runs = 0;
  const decisions = [];
  const reactivated = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => { throw new Error("offline reactivate must not discover"); } }),
    {
      markerStore: store,
      reactivateOnCredentialRotation: true,
      onDecision: (decision) => decisions.push(decision),
      run: async ({ credential }) => {
        runs += 1;
        assert.equal(credential.refresh, rotated.refresh);
        return { stopReason: "stop" };
      },
    },
  );
  const { published } = await twoPhaseRefresh(reactivated, {
    store: persisted,
    storedCredential: rotated,
    allowNetwork: false,
  });
  assert.equal(runs, 1, "재로그인 오프라인 동기화가 canary를 건너뛰었다");
  assert.equal(published.length, 1, "canary 뒤에 저장분이 공개되지 않았다");
  assert.notEqual(store.text, previousMarker, "새 자격증명으로 marker를 다시 발급하지 않았다");
  assert.equal(decisions.some((decision) => decision.ok && decision.phase === "activate"), true);
});

test("같은 인스턴스에서 재로그인하면 canary가 다시 돈다", async () => {
  let runs = 0;
  const store = memoryMarkerStore();
  const provider = withCursorActivationCanary(
    pinnedShapedCursor({ fetchModels: async () => [discoveredModel("composer-1")] }),
    {
      markerStore: store,
      reactivateOnCredentialRotation: true,
      run: async () => {
        runs += 1;
        return { stopReason: "stop" };
      },
    },
  );
  const first = await twoPhaseRefresh(provider, { storedCredential: CREDENTIAL });
  const persisted = first.published.at(-1).persist;
  assert.equal(runs, 1, "첫 활성화 canary가 없다");
  await twoPhaseRefresh(provider, {
    store: persisted,
    storedCredential: { ...CREDENTIAL, refresh: "after-relogin" },
    allowNetwork: false,
  });
  assert.equal(runs, 2, "settle 된 inflight를 재사용하면 새 자격증명을 검증하지 않는다");
});

test("증명 판정은 전부 fail closed 고, 세대는 값을 담지 않는다", () => {
  const models = [discoveredModel("composer-1")];
  const marker = issueCursorActivationMarker({ credential: CREDENTIAL, models, now: 1_000 });
  assert.equal(verifyCursorActivationMarker({ marker, credential: CREDENTIAL, models, now: 1_000 }).ok, true);
  // 입력 자체가 없거나 형태가 아니면 통과시킬 근거가 없다.
  for (const bad of [undefined, null, "", "{", "3", '"text"', {}, { version: 1 }]) {
    assert.equal(verifyCursorActivationMarker({ marker: bad, credential: CREDENTIAL, models }).ok, false, JSON.stringify(bad));
  }
  // 증명 없이는 어느 쪽 세대도 만들 수 없다.
  assert.equal(issueCursorActivationMarker({ credential: undefined, models }), undefined);
  assert.equal(issueCursorActivationMarker({ credential: CREDENTIAL, models: [] }), undefined);
  assert.equal(cursorCredentialGeneration({ type: "oauth", access: "a" }, "s"), undefined, "refresh 가 없으면 세대가 없다");
  // 세대는 salt 마다 다르고 값을 되돌릴 수 없다.
  const a = cursorCredentialGeneration(CREDENTIAL, "salt-a");
  const b = cursorCredentialGeneration(CREDENTIAL, "salt-b");
  assert.notEqual(a, b, "salt 가 달라도 같은 digest 면 salt 가 무의미하다");
  assert.ok(!a.includes(CREDENTIAL.refresh));
  // catalog 세대는 순서에 의존하지 않고, 목록이 달라지면 달라진다.
  const forward = [discoveredModel("a"), discoveredModel("b")];
  const reversed = [discoveredModel("b"), discoveredModel("a")];
  assert.equal(cursorCatalogGeneration(forward, "s"), cursorCatalogGeneration(reversed, "s"));
  assert.notEqual(cursorCatalogGeneration(forward, "s"), cursorCatalogGeneration([...forward, discoveredModel("c")], "s"));
});

test("증명 경로는 자격증명과 같은 agent 디렉터리에 있고, 명시 override 를 존중한다", () => {
  const home = "/tmp/fake-home-not-used";
  assert.equal(cursorActivationMarkerPath({ RUBATO_CURSOR_ACTIVATION_PATH: "/tmp/x.json" }, home), "/tmp/x.json");
  assert.equal(
    cursorActivationMarkerPath({ SENPI_CODING_AGENT_DIR: "/agent" }, home),
    join("/agent", CURSOR_ACTIVATION_MARKER_FILE),
  );
  assert.equal(
    cursorActivationMarkerPath({ RUBATO_PI_CODING_AGENT_DIR: "/a", SENPI_CODING_AGENT_DIR: "/b" }, home),
    join("/a", CURSOR_ACTIVATION_MARKER_FILE),
  );
  assert.equal(
    cursorActivationMarkerPath({}, home),
    join(home, ".rubato-pi", "agent", CURSOR_ACTIVATION_MARKER_FILE),
  );
});

test("파일 증명 store 는 mode 0600 과 원자적 rename 을 쓴다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-cursor-marker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", CURSOR_ACTIVATION_MARKER_FILE);
  const store = fileActivationMarkerStore(path);
  assert.equal(store.read(), undefined, "없는 파일은 없는 증명이다");
  store.write('{"a":1}\n');
  assert.equal(store.read(), '{"a":1}\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // temp 파일을 남기지 않는다.
  assert.deepEqual(readdirSync(join(dir, "nested")), [CURSOR_ACTIVATION_MARKER_FILE]);
});

test("typed 종료 판정은 문자열이 아니라 구조를 본다", () => {
  // 같은 문장이라도 kind 가 다르면 판정이 다르다. 반대로 kind 가 없으면 unknown 이다.
  assert.deepEqual(cursorTerminalFailure({ errorMessage: "Cursor access token is required", cursorFailure: { kind: "auth" } }), {
    kind: "auth",
    fallbackEligible: false,
  });
  assert.deepEqual(cursorTerminalFailure({ errorMessage: "h2 is not supported", cursorFailure: { kind: "transport" } }), {
    kind: "transport",
    fallbackEligible: true,
  });
  assert.deepEqual(cursorTerminalFailure({ errorMessage: "h2 is not supported" }), { kind: "unknown", fallbackEligible: false });
  assert.deepEqual(cursorTerminalFailure({ cursorFailure: { kind: "made-up" } }), { kind: "unknown", fallbackEligible: false });
});

// ------------------------------------------------- pinned vendor 판정 (offline)

test("pinned 판정: Connect/gRPC 코드가 종료 종류로 접힌다", () => {
  const { cursorFailureKindForConnectCode, cursorFailureDescriptor, tagCursorFailure } = cursorAgent;
  assert.equal(cursorFailureKindForConnectCode("unauthenticated"), "auth");
  assert.equal(cursorFailureKindForConnectCode("16"), "auth", "숫자 gRPC status 도 같은 판정이어야 한다");
  assert.equal(cursorFailureKindForConnectCode("permission_denied"), "auth");
  assert.equal(cursorFailureKindForConnectCode("canceled"), "cancelled");
  assert.equal(cursorFailureKindForConnectCode("resource_exhausted"), "content");
  assert.equal(cursorFailureKindForConnectCode("invalid_argument"), "content");
  assert.equal(cursorFailureKindForConnectCode("unavailable"), "transport");
  assert.equal(cursorFailureKindForConnectCode("deadline_exceeded"), "transport");
  // 경로 인과가 증명되지 않은 server-side 조건은 route 실패가 아니다. 자동 전환
  // 후보(`transport`/`protocol`)로 분류하면 "다른 경로에서 우연히 됐다"를 근거로
  // 경로를 바꾸게 된다.
  for (const code of ["internal", "data_loss", "not_found", "unimplemented"]) {
    assert.equal(cursorFailureKindForConnectCode(code), "unknown", code);
  }
  assert.equal(cursorFailureKindForConnectCode("nonsense"), "unknown");

  // transport/protocol 만 fallback 후보다.
  assert.deepEqual(cursorFailureDescriptor(tagCursorFailure(new Error("x"), "transport")), { kind: "transport", fallbackEligible: true });
  assert.deepEqual(cursorFailureDescriptor(tagCursorFailure(new Error("x"), "auth")), { kind: "auth", fallbackEligible: false });
  // abort 는 원인 태그보다 우선한다 — 사용자가 끊은 것을 경로 실패로 읽으면 안 된다.
  assert.deepEqual(cursorFailureDescriptor(tagCursorFailure(new Error("x"), "transport"), { aborted: true }), {
    kind: "cancelled",
    fallbackEligible: false,
  });
  // 태그가 없으면 unknown 이고, unknown 은 후보가 아니다.
  assert.deepEqual(cursorFailureDescriptor(new Error("h2 is not supported")), { kind: "unknown", fallbackEligible: false });
});

test("pinned 판정: HTTP/2 협상 실패는 transport 로 태그된다", () => {
  const { mapH2TransportError, cursorFailureDescriptor } = cursorAgent;
  const alpn = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
  const mapped = mapH2TransportError(alpn, "https://api2.cursor.sh");
  assert.equal(cursorFailureDescriptor(mapped).kind, "transport");
  assert.equal(cursorFailureDescriptor(mapped).fallbackEligible, true);
});

test("native Cursor HTTP/2 실패는 프록시 fallback 이 없다고 말한다", async () => {
  const alpn = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
  const mapped = cursorAgent.mapH2TransportError(alpn, "https://api2.cursor.sh");
  assert.equal(isCursorHttp2Failure(mapped), true);
  assert.equal(rewriteCursorHttp2Error(mapped).message, CURSOR_HTTP2_REQUIRED_MESSAGE);
  assert.match(CURSOR_HTTP2_REQUIRED_MESSAGE, /HTTP\/2/);
  assert.match(CURSOR_HTTP2_REQUIRED_MESSAGE, /no proxy fallback/);

  await assert.rejects(
    () => runCursorCanary({
      provider: {},
      models: [discoveredModel("composer-1")],
      credential: CREDENTIAL,
      run: async () => { throw mapped; },
    }),
    (error) => {
      assert.ok(error instanceof CursorCanaryError);
      assert.equal(error.reason, "transport");
      assert.equal(error.message, CURSOR_HTTP2_REQUIRED_MESSAGE);
      return true;
    },
  );

  const inner = {
    streamSimple() {
      throw mapped;
    },
    refreshModels: async () => {},
  };
  const provider = await cursorDirectProvider({ provider: inner, markerStore: memoryMarkerStore() });
  assert.throws(
    () => provider.streamSimple(discoveredModel("composer-1"), { messages: [] }, {}),
    (error) => error.message === CURSOR_HTTP2_REQUIRED_MESSAGE,
  );
});

test("pinned 판정: 재시도 소진은 retryCause 로 분류된다", async () => {
  const { cursorFailureDescriptor } = cursorAgent;
  const { CursorRetryableStreamError } = await import(piAi("dist/api/cursor-agent/stream-retry.js"));
  assert.equal(cursorFailureDescriptor(new CursorRetryableStreamError("m", "transport")).kind, "transport");
  assert.equal(cursorFailureDescriptor(new CursorRetryableStreamError("m", "stall")).kind, "transport");
  assert.equal(cursorFailureDescriptor(new CursorRetryableStreamError("m", "clean-end")).kind, "protocol");
});

// ------------------------------------------- caller header / exec 의미 (offline)

test("pinned sanitizeCursorCallerHeaders 가 x-session-id 를 보존한다", () => {
  const sanitized = cursorAgent.sanitizeCursorCallerHeaders({
    "x-session-id": "rubato-session-1",
    "X-Session-Affinity": "rubato-session-1",
    // 예약/금지 header 는 떨어져야 한다 — 남으면 HTTP/2 요청이 아예 서지 않는다.
    authorization: "Bearer leaked",
    "x-cursor-client-version": "spoofed",
    host: "evil.example",
    "content-length": "7",
    ":method": "GET",
    Connection: "keep-alive",
  });
  assert.equal(sanitized["x-session-id"], "rubato-session-1", "이 header 가 빠지면 cache 판정을 비교할 수 없다");
  assert.equal(sanitized["x-session-affinity"], "rubato-session-1", "caller header 는 소문자로 정규화된다");
  for (const field of ["authorization", "x-cursor-client-version", "host", "content-length", ":method", "connection"]) {
    assert.ok(!(field in sanitized), `${field} 가 통과했다`);
  }
});

test("server-exec 표지와 local-work 위임은 pinned 그대로다", async () => {
  const { isCursorExecResolved, kCursorExecResolved } = await import(piAi("dist/index.js"));
  // module-local 표지 판정. 우리가 별도 shadow map 을 만들지 않는다.
  assert.equal(isCursorExecResolved({ [kCursorExecResolved]: true }), true);
  assert.equal(isCursorExecResolved({ type: "toolCall" }), false);
  assert.equal(isCursorExecResolved(undefined), false);

  // lazy stream 이 local-work 질문을 안쪽 provider stream 으로 위임한다(Phase 0 patch).
  const { lazyStream } = await import(piAi("dist/api/lazy.js"));
  const { AssistantMessageEventStream } = await import(piAi("dist/utils/event-stream.js"));
  const inner = new AssistantMessageEventStream();
  let releaseWork;
  inner.trackLocalWork(new Promise((resolve) => { releaseWork = resolve; }));
  const outer = lazyStream({ provider: "cursor", id: "composer-1", api: "cursor-agent" }, async () => inner);
  // setup 이 정착할 때까지 microtask 를 흘린다.
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
  assert.equal(outer.hasPendingLocalWork(), true, "server-driven tool 실행 중 idle watchdog 가 요청을 끊는다");
  releaseWork();
  inner.push({ type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } });
  inner.end();
});

test("저장분 베이스 stream 도 catalog Fast 로 pin 한다", async () => {
  let seen;
  const inner = {
    getModels: () => [discoveredModel("cursor-grok-4.6"), discoveredModel("cursor-grok-4.6-high-fast")],
    streamSimple(_model, _context, options) {
      seen = options.thinkingSelection;
      return { [Symbol.asyncIterator]: async function* () {} };
    },
    refreshModels: async () => {},
  };
  const provider = await cursorDirectProvider({
    provider: inner,
    markerStore: memoryMarkerStore(),
    run: async () => ({ stopReason: "stop" }),
  });
  provider.streamSimple(
    discoveredModel("cursor-grok-4.6"),
    { messages: [] },
    { thinkingSelection: { level: "high", source: "explicit" } },
  );
  assert.equal(seen?.legacyVariantId, "cursor-grok-4.6-high-fast");
});

test("피커 filterModels 는 쓰던 일곱만 남긴다", async () => {
  const provider = await cursorDirectProvider({
    provider: pinnedShapedCursor({ fetchModels: async () => [] }),
    markerStore: memoryMarkerStore(),
    run: async () => ({ stopReason: "stop" }),
  });
  const filtered = provider.filterModels([
    discoveredModel("claude-opus-4-7"),
    discoveredModel("composer-2.5"),
    discoveredModel("gpt-5.6-sol"),
    discoveredModel("default"),
  ]);
  assert.deepEqual(filtered.map((model) => model.id), ["gpt-5.6-sol", "composer-2.5"]);
});
