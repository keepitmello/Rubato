import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureModelsConfig,
  ensureSessionDefaults,
  modelsLookCurrent,
  PROMPT_CACHE_SAFETY_BUFFER_SECONDS,
  sessionDefaultsLookCurrent,
  settingsLookCurrent,
} from "../../src/session-defaults.mjs";

test("session defaults preserve a selected model without dropping other settings", () => {
  const written = {};
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: (path) => path.endsWith("settings.json"),
    readFile: () => JSON.stringify({
      theme: "dark",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    }),
    writeFile: (path, text) => {
      written[path] = text;
    },
  });
  assert.equal(next.defaultProvider, "openai-codex");
  assert.equal(next.defaultModel, "gpt-5.6-sol");
  assert.equal(next.theme, "dark");
  assert.equal(next.hideThinkingBlock, true);
  assert.equal(next.tips, false);
  assert.ok(next.disabledBuiltinExtensions.includes("claude-sdk-oauth"));
  assert.ok(next.disabledBuiltinExtensions.includes("cursor-cli-oauth"));
  assert.match(written["/tmp/agent/settings.json"], /gpt-5\.6-sol/);
});

test("session defaults initialize Opus only when no model was selected", () => {
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: () => false,
    readFile: () => "{}",
    writeFile: () => {},
  });
  assert.equal(next.defaultProvider, "anthropic");
  assert.equal(next.defaultModel, "claude-opus-5");
});

test("session defaults preserve an explicit thinking visibility preference", () => {
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: (path) => path.endsWith("settings.json"),
    readFile: () => JSON.stringify({ hideThinkingBlock: false }),
    writeFile: () => {},
  });
  assert.equal(next.hideThinkingBlock, false);
});

test("models.json disables vercel and other foreign builtins without dropping user providers", () => {
  let written = "";
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({
      providers: { custom: { name: "mine" } },
      disabledProviders: ["already-off"],
    }),
    writeFile: (_path, text) => {
      written = text;
    },
  });
  assert.equal(next.providers.custom.name, "mine");
  assert.ok(next.disabledProviders.includes("already-off"));
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"));
  assert.ok(next.disabledProviders.includes("alibaba-token-plan"));
  // Codex 를 직접 물면서 브로커가 서비스하는 id 가 openai -> openai-codex 로 바뀌었다.
  for (const kept of ["anthropic", "openai-codex", "xai"]) {
    assert.ok(!next.disabledProviders.includes(kept), `${kept} is served by the broker`);
  }
  assert.match(written, /vercel-ai-gateway/);
});

// 회귀: Codex 를 직접 물기 전에는 openai-codex 가 정당하게 disabled 로 박혔다.
// 그 뒤 우리 프로바이더가 되었는데도 파일에 남은 옛 항목 탓에 피커에서 사라졌다.
// 이제는 우리 것으로 돌아온 id 를 파일에서 회수한다.
test("models.json reclaims a provider that became ours after it was disabled", () => {
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({
      providers: {},
      disabledProviders: ["openai-codex", "vercel-ai-gateway"],
    }),
    writeFile: () => {},
  });
  assert.ok(!next.disabledProviders.includes("openai-codex"), "stale openai-codex must be reclaimed");
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"), "genuinely foreign ids stay disabled");
});

test("already-current session files are left untouched", () => {
  const written = {};
  const settings = {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5",
    hideThinkingBlock: true,
    tips: false,
    retry: { maxRetries: 5, modelFallback: false },
    promptCache: { cacheAwareTimeouts: true, safetyBufferSeconds: 300 },
    disabledBuiltinExtensions: ["claude-sdk-oauth", "cursor-cli-oauth"],
    theme: "dark",
  };
  const models = {
    providers: {},
    disabledProviders: ["vercel-ai-gateway", "alibaba-token-plan"],
  };
  const files = {
    "/tmp/agent/settings.json": JSON.stringify(settings),
    "/tmp/agent/models.json": JSON.stringify(models),
  };
  const hooks = {
    exists: (path) => path in files,
    readFile: (path) => files[path],
    writeFile: (path, text) => {
      written[path] = text;
    },
  };
  assert.equal(sessionDefaultsLookCurrent("/tmp/agent", hooks), true);
  const next = ensureSessionDefaults("/tmp/agent", hooks);
  assert.equal(next.theme, "dark");
  assert.deepEqual(written, {});
});

// FX bridge 삭제 전에는 이 판정이 살아 있는 catalog 를 받았다. 그때는 bridge 가 우리가
// 모르는 provider 를 열 수 있었으므로 "지금 무엇이 우리 것인가"를 런타임에 물어야 했다.
// 이제 지원 목록이 정적이라 판정도 그 목록만 본다.
test("지원하지 않는 id 를 끈 파일은 그대로 현재로 본다", () => {
  assert.equal(modelsLookCurrent({ disabledProviders: ["vercel-ai-gateway", "newco"] }), true);
});

test("stale models that still disable a supported provider are not treated as current", () => {
  assert.equal(
    modelsLookCurrent(
      { disabledProviders: ["vercel-ai-gateway", "openai-codex"] },
      [{ id: "openai-codex/gpt-5.6-sol" }],
    ),
    false,
  );
  assert.equal(
    settingsLookCurrent({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-5",
      hideThinkingBlock: true,
      tips: false,
      disabledBuiltinExtensions: ["claude-sdk-oauth"],
      retry: { maxRetries: 5 },
    }),
    false,
  );
});

// 거절을 만났을 때 모델을 갈아타지 않고 턴을 멈추게 하는 스위치다.
// 엔진 기본값이 true 라 명시로 꺼야 한다.
test("model fallback 은 기본으로 꺼진 채로 쓴다", () => {
  const written = {};
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: () => false,
    readFile: () => "{}",
    writeFile: (path, text) => {
      written[path] = text;
    },
  });
  assert.equal(next.retry.modelFallback, false);
  assert.equal(JSON.parse(written["/tmp/agent/settings.json"]).retry.modelFallback, false);
});

// 사용자가 직접 켜 둔 값은 우리 기본값이 덮지 않는다.
test("사용자가 적어 둔 modelFallback 은 그대로 둔다", () => {
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: () => true,
    readFile: (path) =>
      path.endsWith("settings.json")
        ? JSON.stringify({ retry: { modelFallback: true } })
        : JSON.stringify({ providers: {}, disabledProviders: [] }),
    writeFile: () => {},
  });
  assert.equal(next.retry.modelFallback, true);
});

// 회수 대상은 정적 지원 목록이다. bridge catalog 가 사라지면서 두 가지가 같이 바뀐다:
// catalog 에 없어서 회수되지 않던 cursor/kiro/google-antigravity 는 이제 회수되고,
// bridge 가 서비스해서 회수됐던 `openai` 는 우리 id 가 아니므로 disabled 로 남는다.
test("models.json reclaims every supported provider and leaves foreign ids disabled", () => {
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({
      providers: {},
      disabledProviders: ["openai", "cursor", "kiro", "google-antigravity", "vercel-ai-gateway"],
    }),
    writeFile: () => {},
  });
  for (const id of ["cursor", "kiro", "google-antigravity"]) {
    assert.ok(!next.disabledProviders.includes(id), `${id} 는 직결 소유이므로 회수해야 한다`);
  }
  assert.ok(next.disabledProviders.includes("openai"), "우리가 등록하지 않는 openai 는 계속 끈다");
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"), "foreign builtin 은 계속 끈다");
});

// Senpi 엔진 기본 safety buffer 는 30초다. Rubato 는 5분 여유를 settings.json 에
// 박아서 Codex GPT-5.6+ 가 25분, Anthropic long 이 55분 대기하게 한다.
test("새 설치의 promptCache 는 cache-aware 와 5분 safety buffer 를 받는다", () => {
  const written = {};
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: () => false,
    readFile: () => "{}",
    writeFile: (path, text) => {
      written[path] = text;
    },
  });
  assert.equal(next.promptCache.cacheAwareTimeouts, true);
  assert.equal(next.promptCache.safetyBufferSeconds, PROMPT_CACHE_SAFETY_BUFFER_SECONDS);
  assert.equal(next.promptCache.safetyBufferSeconds, 300);
  const saved = JSON.parse(written["/tmp/agent/settings.json"]);
  assert.equal(saved.promptCache.cacheAwareTimeouts, true);
  assert.equal(saved.promptCache.safetyBufferSeconds, 300);
});

test("promptCache 사용자 하위키는 남기고 policy-owned 키만 현재로 맞춘다", () => {
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: (path) => path.endsWith("settings.json") || path.endsWith("models.json"),
    readFile: (path) =>
      path.endsWith("settings.json")
        ? JSON.stringify({
            promptCache: {
              cacheAwareTimeouts: false,
              safetyBufferSeconds: 30,
              keepAlive: { enabled: true, marginSeconds: 12 },
              goalBackstopMaxSeconds: 900,
            },
          })
        : JSON.stringify({ providers: {}, disabledProviders: ["vercel-ai-gateway"] }),
    writeFile: () => {},
  });
  assert.equal(next.promptCache.cacheAwareTimeouts, true);
  assert.equal(next.promptCache.safetyBufferSeconds, 300);
  assert.deepEqual(next.promptCache.keepAlive, { enabled: true, marginSeconds: 12 });
  assert.equal(next.promptCache.goalBackstopMaxSeconds, 900);
});

test("나머지가 현재여도 옛 promptCache 설정은 다음 launch 에서 다시 쓴다", () => {
  const settings = {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5",
    hideThinkingBlock: true,
    tips: false,
    retry: { maxRetries: 5, modelFallback: false },
    promptCache: {
      cacheAwareTimeouts: true,
      safetyBufferSeconds: 30,
      keepAlive: { enabled: true },
    },
    disabledBuiltinExtensions: ["claude-sdk-oauth", "cursor-cli-oauth"],
  };
  const models = {
    providers: {},
    disabledProviders: ["vercel-ai-gateway", "alibaba-token-plan"],
  };
  const files = {
    "/tmp/agent/settings.json": JSON.stringify(settings),
    "/tmp/agent/models.json": JSON.stringify(models),
  };
  const written = {};
  const hooks = {
    exists: (path) => path in files,
    readFile: (path) => files[path],
    writeFile: (path, text) => {
      written[path] = text;
    },
  };

  assert.equal(sessionDefaultsLookCurrent("/tmp/agent", hooks), false);
  const next = ensureSessionDefaults("/tmp/agent", hooks);
  assert.equal(next.promptCache.safetyBufferSeconds, 300);
  assert.deepEqual(next.promptCache.keepAlive, { enabled: true });
  assert.equal(JSON.parse(written["/tmp/agent/settings.json"]).promptCache.safetyBufferSeconds, 300);
});

test("자식 입학용 Flash 는 google-antigravity 를 켜 두고 cursor-cli-oauth 를 꺼 둔다", () => {
  const written = {};
  const next = ensureSessionDefaults("/tmp/agent", {
    exists: () => true,
    readFile: (path) =>
      path.endsWith("settings.json")
        ? JSON.stringify({
            defaultProvider: "anthropic",
            defaultModel: "claude-opus-5",
            disabledBuiltinExtensions: [],
          })
        : JSON.stringify({
            providers: {},
            disabledProviders: ["google-antigravity", "vercel-ai-gateway"],
          }),
    writeFile: (path, text) => {
      written[path] = text;
    },
  });
  assert.ok(next.disabledBuiltinExtensions.includes("cursor-cli-oauth"));
  const models = JSON.parse(written["/tmp/agent/models.json"]);
  assert.ok(!models.disabledProviders.includes("google-antigravity"));
  assert.ok(JSON.parse(written["/tmp/agent/settings.json"]).disabledBuiltinExtensions.includes("cursor-cli-oauth"));
});

test("옛 safety buffer 만 있는 설정은 현재가 아니다", () => {
  const base = {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5",
    hideThinkingBlock: true,
    tips: false,
    retry: { maxRetries: 5, modelFallback: false },
    disabledBuiltinExtensions: ["claude-sdk-oauth", "cursor-cli-oauth"],
  };
  assert.equal(settingsLookCurrent({ ...base, promptCache: { cacheAwareTimeouts: true, safetyBufferSeconds: 30 } }), false);
  assert.equal(settingsLookCurrent({ ...base, promptCache: { cacheAwareTimeouts: true, safetyBufferSeconds: 300 } }), true);
});
