// Kiro 직결 provider 의 계약. **실제 `~/.rubato-pi` 도 :8990 도 건드리지 않는다** —
// config 는 임시 디렉터리에 두고, wire 는 주입 fetch 로 가로챈다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_KIRO_BASE_URL,
  KIRO_API_KEY_ENV,
  KIRO_BASE_URL_ENV,
  KIRO_CONFIG_PATH_ENV,
  KIRO_PROVIDER_ID,
  defaultKiroConfigPath,
  isLoopbackUrl,
  kiroApiKey,
  kiroApiKeyAuth,
  kiroBaseUrl,
  kiroConfigPath,
  kiroDirectProvider,
  kiroEnsureEnabled,
  kiroModels,
  ensureKiroSidecar,
  withKiroSidecarEnsure,
} from "../../src/kiro-route.mjs";

/** 실제 사이드카 key 와 겹칠 수 없는 값. `sk-ant-oat` 가 **아니다** — 그것이 계약이다. */
const CONFIG_KEY = "sk-kiro-local-test-only-config";
const ENV_KEY = "sk-kiro-local-test-only-env";

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-kiro-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, body) {
  const path = join(dir, "config.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return path;
}

// -------------------------------------------------------------------- 주소

test("기본 주소는 loopback :8990 이다", () => {
  assert.equal(DEFAULT_KIRO_BASE_URL, "http://127.0.0.1:8990");
  assert.equal(kiroBaseUrl({}), "http://127.0.0.1:8990");
});

test("설정 가능하지만 loopback 만 받는다", () => {
  // 사이드카 앞에 붙는 key 는 로컬 전용이다. 원격 host 를 허용하면 설정 실수 하나가
  // 그 key 를 네트워크로 내보낸다.
  assert.equal(kiroBaseUrl({ [KIRO_BASE_URL_ENV]: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");
  assert.equal(kiroBaseUrl({ [KIRO_BASE_URL_ENV]: "http://localhost:8990" }), "http://localhost:8990");
  assert.equal(kiroBaseUrl({ [KIRO_BASE_URL_ENV]: "http://[::1]:8990" }), "http://[::1]:8990");
  // 끝의 슬래시는 떼어낸다. 남기면 요청 경로가 `//v1/messages` 가 된다.
  assert.equal(kiroBaseUrl({ [KIRO_BASE_URL_ENV]: "http://127.0.0.1:8990/" }), "http://127.0.0.1:8990");
});

test("loopback 이 아닌 주소는 거절하고 기본값으로 돌아간다", () => {
  const rejected = [];
  for (const value of [
    "http://10.0.0.5:8990",
    "https://kiro.example.com",
    "http://127.0.0.1.evil.com:8990",
    "http://0.0.0.0:8990",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(
      kiroBaseUrl({ [KIRO_BASE_URL_ENV]: value }, { onReject: (info) => rejected.push(info.reason) }),
      DEFAULT_KIRO_BASE_URL,
      `${value} 를 받아들였다`,
    );
  }
  assert.equal(rejected.length, 6, "거절은 사유와 함께 알려야 한다");
  assert.deepEqual([...new Set(rejected)], ["not_loopback"]);
});

test("loopback 판정 자체", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8990"), true);
  assert.equal(isLoopbackUrl("http://localhost"), true);
  assert.equal(isLoopbackUrl("https://127.0.0.1"), true);
  assert.equal(isLoopbackUrl("http://[::1]"), true);
  assert.equal(isLoopbackUrl("http://192.168.1.5"), false);
  // 127.x 전체를 열지 않는다. 기본 사이드카 주소 하나를 가리키는 것이 목적이다.
  assert.equal(isLoopbackUrl("http://127.0.0.2"), false);
  assert.equal(isLoopbackUrl("ws://127.0.0.1"), false);
  assert.equal(isLoopbackUrl(""), false);
});

// ------------------------------------------------------------------- key 출처

test("config 경로 기본값과 override", () => {
  const home = "/tmp/fake-home-not-used";
  assert.equal(defaultKiroConfigPath(home), join(home, ".rubato-pi", "kiro", "config.json"));
  assert.equal(kiroConfigPath({}, home), join(home, ".rubato-pi", "kiro", "config.json"));
  assert.equal(kiroConfigPath({ [KIRO_CONFIG_PATH_ENV]: "/x/kiro.json" }, home), "/x/kiro.json");
});

test("env key 가 config 파일을 이긴다", (t) => {
  const dir = box(t);
  const path = writeConfig(dir, { apiKey: CONFIG_KEY });
  const found = kiroApiKey({ [KIRO_API_KEY_ENV]: ENV_KEY, [KIRO_CONFIG_PATH_ENV]: path });
  assert.equal(found.key, ENV_KEY);
  assert.equal(found.source, KIRO_API_KEY_ENV);
});

test("env 가 없으면 kiro-setup.sh 가 쓴 config 를 읽는다", (t) => {
  const dir = box(t);
  const path = writeConfig(dir, { host: "0.0.0.0", port: 8990, apiKey: CONFIG_KEY, region: "us-east-1" });
  const found = kiroApiKey({ [KIRO_CONFIG_PATH_ENV]: path });
  assert.equal(found.key, CONFIG_KEY);
  assert.equal(found.source, "kiro config");
});

test("config 가 없거나 깨졌으면 auth 만 꺼지고 던지지 않는다", (t) => {
  const dir = box(t);
  // 이것이 계약의 핵심이다: Kiro 를 쓰지 않는(또는 설정이 깨진) 사용자의 세션에서
  // 다른 provider 가 함께 죽으면 안 된다.
  const cases = {
    absent: join(dir, "does-not-exist.json"),
    "깨진 JSON": writeConfig(dir, '{"apiKey": '),
    배열: writeConfig(dir, [{ apiKey: CONFIG_KEY }]),
    null: writeConfig(dir, null),
    문자열: writeConfig(dir, '"just a string"'),
    "apiKey 없음": writeConfig(dir, { port: 8990 }),
    "apiKey 가 문자열이 아님": writeConfig(dir, { apiKey: 12345 }),
    "apiKey 가 빈 문자열": writeConfig(dir, { apiKey: "" }),
  };
  for (const [label, path] of Object.entries(cases)) {
    assert.equal(kiroApiKey({ [KIRO_CONFIG_PATH_ENV]: path }), undefined, `${label} 에서 key 가 나왔다`);
  }
});

test("key 를 캐시하지 않는다 — kiro-setup.sh 가 바꾸면 그것이 보인다", (t) => {
  const dir = box(t);
  const path = writeConfig(dir, { apiKey: CONFIG_KEY });
  const env = { [KIRO_CONFIG_PATH_ENV]: path };
  assert.equal(kiroApiKey(env).key, CONFIG_KEY);
  writeConfig(dir, { apiKey: `${CONFIG_KEY}-rotated` });
  assert.equal(kiroApiKey(env).key, `${CONFIG_KEY}-rotated`, "캐시하면 회전된 key 를 못 본다");
});

test("config 파일을 읽기만 한다 — mtime 과 크기가 그대로다", (t) => {
  const dir = box(t);
  const path = writeConfig(dir, { apiKey: CONFIG_KEY });
  const before = statSync(path);
  kiroApiKey({ [KIRO_CONFIG_PATH_ENV]: path });
  const after = statSync(path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
});

test("auth resolve: 저장된 자격증명 → env → config 순서", async (t) => {
  const dir = box(t);
  const path = writeConfig(dir, { apiKey: CONFIG_KEY });

  const fromStored = await kiroApiKeyAuth({ env: { [KIRO_CONFIG_PATH_ENV]: path } }).resolve({
    credential: { type: "api_key", key: "stored-kiro-key" },
  });
  assert.equal(fromStored.auth.apiKey, "stored-kiro-key");
  assert.equal(fromStored.source, "stored credential");

  const fromEnv = await kiroApiKeyAuth({
    env: { [KIRO_API_KEY_ENV]: ENV_KEY, [KIRO_CONFIG_PATH_ENV]: path },
  }).resolve({});
  assert.equal(fromEnv.auth.apiKey, ENV_KEY);

  const fromConfig = await kiroApiKeyAuth({ env: { [KIRO_CONFIG_PATH_ENV]: path } }).resolve({});
  assert.equal(fromConfig.auth.apiKey, CONFIG_KEY);

  const nothing = await kiroApiKeyAuth({
    env: { [KIRO_CONFIG_PATH_ENV]: join(dir, "absent.json") },
  }).resolve({});
  assert.equal(nothing, undefined, "없으면 undefined — 던지면 다른 provider 까지 막는다");
});

test("login 은 설정 스크립트를 가리킨다", async () => {
  // 조용히 성공하는 login 을 두면 사용자는 붙었다고 믿고 첫 요청에서 401 을 본다.
  await assert.rejects(() => kiroApiKeyAuth({ env: {} }).login({}), /kiro-setup\.sh/);
});

// -------------------------------------------------------------- 모델 metadata

test("모델은 정확히 둘이고 상한이 고정이다", () => {
  const models = kiroModels(DEFAULT_KIRO_BASE_URL);
  assert.deepEqual(models.map((model) => model.id), ["claude-opus-5", "gpt-5.6-sol"]);

  const opus = models[0];
  const sol = models[1];
  assert.equal(opus.contextWindow, 1_000_000);
  assert.equal(sol.contextWindow, 272_000);
  for (const model of models) {
    assert.equal(model.maxTokens, 64_000);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.compat.supportsTemperature, false);
    assert.equal(model.compat.supportsStrictTools, true);
    // 모델 spec 이 자기 provider/baseUrl 을 들고 있어야 한다. 아니면 런타임이
    // "Unknown provider" 로 죽는다.
    assert.equal(model.provider, KIRO_PROVIDER_ID);
    assert.equal(model.baseUrl, DEFAULT_KIRO_BASE_URL);
    assert.equal(model.api, "anthropic-messages");
  }
});

test("모델 baseUrl 은 provider baseUrl 과 같이 움직인다", async () => {
  const provider = await kiroDirectProvider({ env: { [KIRO_BASE_URL_ENV]: "http://127.0.0.1:9191" } });
  assert.equal(provider.baseUrl, "http://127.0.0.1:9191");
  for (const model of provider.getModels()) {
    assert.equal(model.baseUrl, "http://127.0.0.1:9191", "모델이 다른 주소를 가리키면 요청이 갈라진다");
  }
});

test("provider 모양: pinned createProvider 산물이다", async () => {
  const provider = await kiroDirectProvider({ env: {} });
  assert.equal(provider.id, "kiro");
  assert.equal(provider.name, "Kiro");
  assert.equal(provider.baseUrl, DEFAULT_KIRO_BASE_URL);
  assert.equal(typeof provider.stream, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof provider.auth.apiKey.resolve, "function");
  assert.equal(provider.auth.oauth, undefined, "로컬 사이드카에 OAuth 흐름은 없다");
});

test("module import 시점에는 사용자 설정을 읽지 않는다", async () => {
  // import 부작용으로 파일을 읽으면, 이 모듈을 스치는 모든 경로가 사용자 홈을 만진다.
  let reads = 0;
  const counting = () => {
    reads += 1;
    throw new Error("읽으면 안 된다");
  };
  const fresh = await import(`../../src/kiro-route.mjs?fresh=${Date.now()}`);
  assert.equal(reads, 0);
  // 그리고 provider 를 만드는 것만으로도 아직 읽지 않는다 — 읽기는 resolve 시점이다.
  const provider = await fresh.kiroDirectProvider({ env: {}, readFileImpl: counting });
  assert.equal(reads, 0, "provider 구성이 config 를 읽었다");
  assert.equal(await provider.auth.apiKey.resolve({}), undefined);
  assert.equal(reads, 1, "resolve 시점에 정확히 한 번 읽어야 한다");
});

// 삭제된 FX bridge 로 되돌아가는 문을 loopback 허용이 열어 두면 안 된다. 이 기기에서는 그
// 포트에 다른 세션들이 쓰는 공유 bridge 가 살아 있어서, 통과시키면 사이드카 대신 그것과 말한다.
test("RUBATO_NO_KIRO_ENSURE 가 켜지면 ensure 를 건너뛴다", async () => {
  assert.equal(kiroEnsureEnabled({ RUBATO_NO_KIRO_ENSURE: "1" }), false);
  let spawned = 0;
  await ensureKiroSidecar({ RUBATO_NO_KIRO_ENSURE: "1" }, {
    spawnImpl: () => {
      spawned += 1;
      throw new Error("spawned");
    },
  });
  assert.equal(spawned, 0);
});

test("겹친 ensure 는 한 번만 돌고 끝나면 다시 열린다", async () => {
  let started = 0;
  const makeChild = () => {
    started += 1;
    const handlers = {};
    return {
      stderr: { setEncoding() {}, on() {} },
      once(event, fn) { handlers[event] = fn; },
      finish() { handlers.exit?.(0); },
    };
  };
  let first;
  const firstCall = ensureKiroSidecar({ PATH: "/bin" }, {
    spawnImpl: () => {
      first = makeChild();
      return first;
    },
  });
  const secondCall = ensureKiroSidecar({ PATH: "/bin" }, {
    spawnImpl: () => {
      throw new Error("second spawn");
    },
  });
  first.finish();
  await Promise.all([firstCall, secondCall]);
  assert.equal(started, 1);

  let third;
  const thirdCall = ensureKiroSidecar({ PATH: "/bin" }, {
    spawnImpl: () => {
      third = makeChild();
      return third;
    },
  });
  third.finish();
  await thirdCall;
  assert.equal(started, 2);
});

test("stream 은 ensure 가 끝난 뒤에야 안쪽을 열고, getModels 는 깨우지 않는다", async () => {
  const order = [];
  const inner = {
    id: "kiro",
    getModels: () => {
      order.push("models");
      return [];
    },
    stream: () => {
      order.push("inner");
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done" }; },
        result: async () => ({ stopReason: "end_turn" }),
      };
    },
  };
  const wrapped = withKiroSidecarEnsure(inner, async () => { order.push("ensure"); });
  assert.deepEqual(wrapped.getModels(), []);
  assert.deepEqual(order, ["models"]);
  const events = [];
  for await (const event of wrapped.stream({}, {}, {})) events.push(event);
  assert.deepEqual(order, ["models", "ensure", "inner"]);
  assert.deepEqual(events, [{ type: "done" }]);
});

test("사이드카 주소는 legacy bridge 포트를 거부하고 기본값으로 되돌린다", () => {
  for (const port of ["8788", "18788"]) {
    const rejected = [];
    const resolved = kiroBaseUrl(
      { [KIRO_BASE_URL_ENV]: `http://127.0.0.1:${port}` },
      { onReject: (info) => rejected.push(info.reason) },
    );
    assert.equal(resolved, DEFAULT_KIRO_BASE_URL, `${port} 가 통과했다`);
    assert.deepEqual(rejected, ["legacy_bridge_port"]);
  }
});
