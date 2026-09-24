// provider 직결 경로의 native provider 구성.
//
// 이 파일은 "무엇을 직결로 보낼지"만 정한다. 실제 stream 의미(계측·timing·정착)는
// `rubato-stream.mjs` 의 decorator 가 소유하고, 등록 순서는 `provider-overlay.mjs` 가
// 소유한다.
//
// FX bridge 가 삭제된 뒤로 직결은 **유일한** 경로다. 예전에는 기본값이 꺼짐이었고
// bridge 가 그 기본값이었는데, 이제 돌아갈 기본값 자신이 없다.
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { withClaudeSetupToken } from "./anthropic-setup-token.mjs";
import { cursorDirectProvider } from "./cursor-route.mjs";
import { senpiNested } from "./engine-paths.mjs";
import { ensureKiroSidecar, kiroDirectProvider, withKiroSidecarEnsure } from "./kiro-route.mjs";
import { antigravityDirectProvider } from "./antigravity-route.mjs";
import {
  ANTHROPIC_PICKER_IDS,
  CODEX_PICKER_IDS,
  OPENCODE_PICKER_IDS,
  XAI_PICKER_IDS,
  withPickerIds,
  withSubAccountCopies,
} from "./picker-catalog.mjs";
import { withOpenCodeKeychain } from "./opencode-keychain.mjs";
import { wrapProviderStreams } from "./rubato-stream.mjs";
import { speedIndexStore } from "./speed-index-store.mjs";
import { SPEED_INDEX_NETWORK_ROUTES } from "./speed-index-routes.mjs";
import { SUPPORTED_PROVIDER_IDS } from "./provider-capabilities.mjs";

export { SPEED_INDEX_NETWORK_ROUTES };

/**
 * 직결 경로를 켜던 스위치의 이름. 이제 **경로를 가르지 않는다.**
 *
 * bridge 가 사라지면서 이 플래그가 고를 다른 경로가 없어졌다. 그래도 이름을 지우지
 * 않는다 — smoke(`direct-real.mjs`)가 여전히 이 이름을 쓰고, 기족 설정에 이 값이 남은
 * 기기가 있다. 한 이름을 한 군데서만 읽는 자리를 유지하는 것이 그것을 여기서 한 번
 * 해석하게 해 준다.
 */
export const PROVIDER_DIRECT_FLAG = "RUBATO_PROVIDER_DIRECT";

/**
 * 직결로 보낼 provider. FX bridge 삭제 뒤로는 이것이 지원하는 전부다.
 *
 * 순서는 `directProviders()` 가 돌려주는 순서이고, 제품 catalog 의 provider 순서와
 * 같은 결이다. 앞의 세 개를 **그 자리에 그대로 둔다** — Phase 0/1/2A 의 테스트가
 * 위치로 provider 를 집는다(`const [codex, xai] = await directProviders()`).
 */
export const DIRECT_PROVIDER_IDS = SUPPORTED_PROVIDER_IDS;

/**
 * legacy `~/.senpi/agent/auth.json` 에서 이관할 provider. **Codex 와 xAI 뿐이다.**
 *
 * Anthropic 과 Kiro 도 없다. 둘의 자격증명은 우리가 갱신하지 않는 값이고 각자
 * 자기 출처에 산다 — setup-token 은 `~/.claude` 와 Keychain, Kiro key 는
 * `kiro-setup.sh` 가 쓴 config 다. 그것을 Rubato AuthStorage 로 복사하면 우리가
 * 소유하지 않는 값의 사본이 생기고, 원본이 바뀌어도 사본이 이긴다.
 *
 * 직결 소유(`DIRECT_PROVIDER_IDS`)와 자격증명 이관은 다른 질문이다. 설계의 인증
 * 전환은 Cursor 를 새 `/login cursor` 로만 세우고 token migration 을 범위에서
 * 제외한다. 그래서 Cursor 를 이관 후보에 넣으면 두 가지가 동시에 깨진다: bridge 가
 * 쓰던 저장소를 직결 권위로 복사해 refresh writer 를 둘로 만들고, 로그인하지 않은
 * 상태(`absent`)가 부팅 판정에 섞인다.
 */
export { IMPORTABLE_PROVIDER_IDS as LEGACY_IMPORT_PROVIDER_IDS } from "./credential-import.mjs";

/**
 * 플래그가 켜졌는가. `"1"` 만 켬으로 읽는 파싱은 예전과 똑같다.
 *
 * 달라진 것은 이 답이 무엇을 정하는가다. 이제 provider 등록은 이것을 보지 않는다 —
 * bridge 가 없으므로 "꺼짐"이 골라질 수 있는 경로가 없고, 거기게 만들면 `=0` 을 둔
 * 기기가 provider 하나 없는 세션을 열게 된다. 남은 사용자는 smoke 와 이 파싱을
 * 계약으로 쓰는 테스트다.
 */
export function providerDirectEnabled(env = process.env) {
  return env?.[PROVIDER_DIRECT_FLAG] === "1";
}

/**
 * 예전 opt-out 을 들고 온 환경에 한 줄 경고한다.
 *
 * `RUBATO_PROVIDER_DIRECT=0` 은 예전에 "bridge 로 가라"는 뜻이었고, 그 bridge 는 이제
 * 없다. 조용히 무시하면 사용자는 자신이 직결을 끈 상태로 돌고 있다고 믿는다. 값은
 * 싣지 않는다 — 이름과 고정된 사유뿐이다.
 */
export function warnIgnoredDirectOptOut(env = process.env, warn = (message) => console.warn(message)) {
  const value = env?.[PROVIDER_DIRECT_FLAG];
  if (value === undefined || value === "1") return false;
  warn(
    `provider-direct: ${PROVIDER_DIRECT_FLAG} is set to something other than "1", but the bridge route it ` +
    "used to select no longer exists. Every provider goes direct; the value is ignored.",
  );
  return true;
}

/**
 * Daybreak 은 pinned catalog 에 없다. Rubato 가 직접 정의하는 유일한 Codex extra 다.
 *
 * 나머지 native 모델 metadata 는 context window 를 제외하면 손대지 않는다.
 * Codex 의 Rubato 상한은 272K 다. pinned catalog 가 더 큰 원시 window 를 싣더라도
 * statusline 과 compaction 이 그 값을 실제 예산으로 오해하지 않게 provider 경계에서
 * 상한을 적용한다. Fast 변형의 `upstreamModelId` + `serviceTier: "priority"` 같은
 * wire metadata 는 그대로 둔다.
 */
// Codex pin 은 minimal 을 low 별칭으로만 싣고 off 는 칸이 아니다.
// Shift+Tab 에 가짜 칸이 섞이지 않게 실제 단계만 남긴다.
const DAYBREAK_THINKING_LEVEL_MAP = Object.freeze({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

const DAYBREAK_BASE_ID = "gpt-daybreak-blue-latest";
const DAYBREAK_FAST_ID = "gpt-daybreak-blue-latest-fast";

const FABLE_51_ID = "claude-fable-5-1";
const FABLE_51_TEMPLATE_ID = "claude-fable-5";

/**
 * Fable 5.1 은 pinned anthropic catalog 에 없다. pin 의 Fable 5에서 파생한다.
 *
 * 필드를 손으로 다 적지 않는다. `api`, `cost`, `compat`, `thinkingLevelMap` 같은
 * 것을 빼뜨리면 provider 가 조용히 다른 요청을 만든다. pin 의 Fable 5를 틀로 쓰고
 * id·표시명만 덮는다.
 */
export function fable51Models(nativeModels) {
  if (nativeModels.some((model) => model.id === FABLE_51_ID)) return [];
  const template = nativeModels.find((model) => model.id === FABLE_51_TEMPLATE_ID);
  if (!template) throw new Error("pinned anthropic catalog has no claude-fable-5 to derive Fable 5.1 from");
  return [{
    ...template,
    id: FABLE_51_ID,
    name: "Fable 5.1",
  }];
}

const OPUS_55_ID = "claude-opus-5-5";
const OPUS_55_TEMPLATE_ID = "claude-opus-5";

/**
 * Opus 5.5 의 가격은 Opus 5 와 **다르다**. 틀에서 물려받으면 25% 과다 계상된다.
 *
 * 공식 가격표(platform.claude.com/docs/en/about-claude/pricing, 2026-09-22)의
 * Opus 5.5 행: base input $4 / 5m cache write $5 / cache hit $0.20 / output $20.
 * Opus 5 는 $5 / $6.25 / $0.50 / $25 다. `cacheRead` 는 base input 의 0.05배라는
 * 각주도 0.20 을 확인해 준다 (다른 모델은 0.1배).
 *
 * `cost.cacheWrite` 는 pin 의 다른 행과 같이 5m 요율이다. Rubato 는 1h 캐시
 * (`CACHE_RETENTION = "long"`, 5.5 는 $8)를 쓰지만 pin 의 cost 에는 1h 칸이 없어
 * 다른 모델도 전부 5m 값만 싣는다.
 */
const OPUS_55_COST = Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });

/**
 * Opus 5.5 는 pinned anthropic catalog 에 없다. pin 을 올릴 수 없다 — 0.86.1 이 최신
 * published 이고 그 카탈로그가 Opus 5 에서 멈춘다. 그래서 pin 의 Opus 5 에서 파생한다.
 *
 * 필드를 손으로 다 적지 않는다. `api`, `compat`, `thinkingLevelMap` 같은 것을 빼뜨리면
 * provider 가 조용히 다른 요청을 만든다. `GET /v1/models` 실측(2026-09-22)에서 5.5 의
 * context(1M)·max output(128k)·effort 단계(low~max)·capability 플래그가 Opus 5 와
 * 전부 같았으므로 Opus 5 가 틀이 된다. id·표시명·**가격**만 덮는다.
 *
 * 이 행만으로는 부족하다. setup-token 레인은 Claude Code 신원으로 나가고 Anthropic 이
 * Opus 5.5 를 Claude Code 2.1.280 이상에만 연다 — 하한은
 * `transforms/misc-claude-code-version.mjs` 가 소유한다.
 */
export function opus55Models(nativeModels) {
  if (nativeModels.some((model) => model.id === OPUS_55_ID)) return [];
  const template = nativeModels.find((model) => model.id === OPUS_55_TEMPLATE_ID);
  if (!template) throw new Error("pinned anthropic catalog has no claude-opus-5 to derive Opus 5.5 from");
  return [{
    ...template,
    id: OPUS_55_ID,
    name: "Opus 5.5",
    cost: OPUS_55_COST,
  }];
}

const GROK_47_ID = "grok-4.7";
const GROK_47_TEMPLATE_ID = "grok-4.6";

/**
 * Grok 4.7 은 pinned xai catalog 에 없다. pin 을 올릴 수 없다 — 0.86.1 이 최신
 * published 이고 그 카탈로그가 4.6 에서 멈춘다. 그래서 pin 의 Grok 4.6 에서 파생한다.
 *
 * 필드를 손으로 다 적지 않는다. `api`, `cost`, `compat`, `thinkingLevelMap` 같은 것을
 * 빼뜨리면 provider 가 조용히 다른 요청을 만든다. xAI 가 보고하는 4.7 의 context
 * (500k)·가격·reasoning 단계가 4.6 과 같아서 4.6 이 그대로 틀이 된다 — id 와 표시명만
 * 덮는다 (2026-09-22 `GET /v1/language-models` 실측).
 */
export function grok47Models(nativeModels) {
  if (nativeModels.some((model) => model.id === GROK_47_ID)) return [];
  const template = nativeModels.find((model) => model.id === GROK_47_TEMPLATE_ID);
  if (!template) throw new Error("pinned xai catalog has no grok-4.6 to derive Grok 4.7 from");
  return [{
    ...template,
    id: GROK_47_ID,
    name: "Grok 4.7",
  }];
}

/**
 * Daybreak 모델 정의를 native 모델 하나에서 파생시킨다.
 *
 * 필드를 손으로 다 적지 않는다. `api`, `cost`, `reasoning` 같은 것을 빠뜨리면
 * provider 가 조용히 다른 요청을 만든다. 같은 계열인 272K native 모델을 틀로 쓰고
 * 다른 것만 덮는다.
 */
export function daybreakModels(nativeModels) {
  const template = nativeModels.find((model) => model.id === "gpt-5.6-terra");
  if (!template) throw new Error("pinned openai-codex catalog has no gpt-5.6-terra to derive Daybreak from");
  const base = {
    ...template,
    id: DAYBREAK_BASE_ID,
    name: "Daybreak Blue",
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: DAYBREAK_THINKING_LEVEL_MAP,
  };
  delete base.upstreamModelId;
  delete base.serviceTier;
  const fast = {
    ...base,
    id: DAYBREAK_FAST_ID,
    name: "Daybreak Blue Fast",
    // Fast 는 별개 모델이 아니라 같은 모델의 우선 처리다. wire 에는 canonical ID 가
    // 가야 하고(`upstreamModelId`), tier 는 `priority` 여야 한다. pinned Fast 변형들이
    // 쓰는 것과 같은 모양이다.
    upstreamModelId: DAYBREAK_BASE_ID,
    serviceTier: "priority",
  };
  return [base, fast];
}

const GPT6_CODEX_IDS = Object.freeze(["gpt-6-sol", "gpt-6-luna"]);

/**
 * 핀 카탈로그(pi-ai 0.86.1)에 아직 없는 GPT-6 두 행.
 *
 * 정의는 상류 0.87.1 의 `dist/providers/data/openai-codex.json` 에서 그대로 옮겼다.
 * `cost`·`thinkingLevelMap` 을 손으로 다시 적으면 조용히 달라지고, 5.6 에서 파생하지도
 * 않는다 — 6 은 개명이 아니라 다른 모델이다: 컨텍스트는 같은 272K 지만 가격이 절반이고
 * (2/10 대 5/30) thinkingLevelMap 이 off·low·medium 을 더 갖는다.
 *
 * `inputLimits`(0.87.0 신설)만 뺐다 — 0.86.1 은 그 필드를 읽지 않는다. 핀을 0.87 이상으로
 * 올리면 네이티브가 이 id 를 갖게 되어 이 주입은 스스로 빈다.
 */
export function gpt6CodexModels(nativeModels) {
  const missing = GPT6_CODEX_IDS.filter((id) => !nativeModels.some((model) => model.id === id));
  if (missing.length === 0) return [];
  // 모듈 상수를 그대로 넘기지 않는다. 이 파일의 파생들은 행을 제자리에서 고친다
  // (`daybreakModels` 의 `delete`) — 공유하면 다음 호출이 그 흔적을 물려받는다.
  return GPT6_CODEX_ROWS.filter((row) => missing.includes(row.id)).map((row) => ({ ...row }));
}

const GPT6_CODEX_COMPAT = Object.freeze({
  supportsOpenAIGrammarTools: true,
  supportsAdditionalTools: true,
  supportsToolSearch: true,
  supportsMidConvoSystemMessages: true,
});

/** 0.87.1 의 thinkingLevelMap 과 같은 값. `off` 는 0.86.1 도 아는 단계다. */
const GPT6_CODEX_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

/** 0.87.1 의 cost 그대로. 5.6 의 값을 물려받으면 두 배로 계상된다. */
const GPT6_SOL_COST = Object.freeze({
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
  tiers: Object.freeze([
    Object.freeze({ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }),
  ]),
});

const GPT6_LUNA_COST = Object.freeze({
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: Object.freeze([
    Object.freeze({ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }),
  ]),
});

// 행 자체는 얼리지 않는다 — Daybreak 처럼 파생 단계가 `delete`·덮어쓰기로 손대는 자리다.
const GPT6_CODEX_ROWS = Object.freeze([
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: GPT6_SOL_COST,
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: GPT6_CODEX_THINKING_LEVEL_MAP,
    compat: GPT6_CODEX_COMPAT,
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: GPT6_LUNA_COST,
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: GPT6_CODEX_THINKING_LEVEL_MAP,
    compat: GPT6_CODEX_COMPAT,
  },
]);

/**
 * Bind native provider loading to one explicit pi-ai package root.
 *
 * Missing files/exports fail at that root; this loader never falls back to the
 * Senpi or process-wide installation. The runtime resolver can therefore pass
 * a verified stock package without changing global module resolution.
 */
export function nativeProviderFactoryLoader(piAiRoot) {
  if (typeof piAiRoot !== "string" || piAiRoot.trim() === "") {
    throw new TypeError("native provider factory loader requires an explicit pi-ai package root");
  }
  const root = resolve(piAiRoot);
  return async (file, exportName) => {
    const source = join(root, "dist", "providers", file);
    const module = await import(pathToFileURL(source).href);
    const factory = module[exportName];
    if (typeof factory !== "function") {
      throw new Error(`pi-ai provider source ${root} has no ${exportName} in providers/${file}`);
    }
    return factory;
  };
}

const loadPinnedFactory = (file, exportName) =>
  nativeProviderFactoryLoader(senpiNested("@earendil-works/pi-ai"))(file, exportName);

/**
 * 모델 목록만 바꿔 끼운 provider. 다른 면은 전부 pinned 그대로다.
 *
 * `getModels` 를 감싸는 것으로 끝낸다. 새 provider 를 만들어 필드를 옮기면 auth,
 * refreshModels, filterModels, headers 가 조용히 빠진다.
 */
function withExtraModels(provider, extra) {
  const nativeGetModels = provider.getModels.bind(provider);
  return {
    ...provider,
    getModels: () => [...nativeGetModels(), ...extra],
  };
}

/** xAI 요청의 `max_output_tokens` 상한. 캐시 키 안정성을 위해 턴마다 같은 값이어야 한다. */
export const XAI_MAX_OUTPUT_TOKENS = 65_536;

function withMaxTokensCap(provider, cap) {
  const nativeGetModels = provider.getModels.bind(provider);
  return {
    ...provider,
    getModels: () => nativeGetModels().map((model) => ({
      ...model,
      maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : cap, cap),
    })),
  };
}

function withContextWindowCap(provider, cap) {
  const nativeGetModels = provider.getModels.bind(provider);
  return {
    ...provider,
    getModels: () => nativeGetModels().map((model) => ({
      ...model,
      contextWindow: Math.min(model.contextWindow, cap),
    })),
  };
}

/**
 * 직결로 등록할 provider 들. 전부 pinned factory 로 만들고 Rubato decorator 로 감싼다.
 *
 * 감싸는 것은 `wrapProviderStreams` 하나뿐이다. native provider 는 `stream`/
 * `streamSimple` 을 provider 객체에 직접 달고 나오므로(`api` 필드가 없다) 그 축이
 * 감싸진다.
 *
 * Cursor 는 `cursor-route.mjs` 의 activation canary gate 를 한 겹 더 지난다. 모델
 * 정의는 하나도 만들지 않는다 — catalog 는 계정별 `GetUsableModels` 가 권위다.
 * Cursor 경로는 native HTTP/2 직결 하나다.
 */
export async function directProviders({
  cursor,
  anthropic,
  kiro,
  antigravity,
  opencode: opencodeOptions,
  env = process.env,
  speedIndexStore: speedStore = speedIndexStore(env),
  nativeFactoryLoader = loadPinnedFactory,
  routeFactories = {},
} = {}) {
  const cursorFactory = routeFactories.cursor ?? cursorDirectProvider;
  const kiroFactory = routeFactories.kiro ?? kiroDirectProvider;
  const antigravityFactory = routeFactories.antigravity ?? antigravityDirectProvider;
  const [openaiCodexProvider, xaiProvider, anthropicProvider, kiroNative, antigravityDirect, cursorProvider, opencodeProvider] = await Promise.all([
    nativeFactoryLoader("openai-codex.js", "openaiCodexProvider"),
    nativeFactoryLoader("xai.js", "xaiProvider"),
    nativeFactoryLoader("anthropic.js", "anthropicProvider"),
    kiroFactory({ env, ...(kiro ?? {}) }),
    antigravityFactory({ env, ...(antigravity ?? {}) }),
    cursorFactory({ env, ...(cursor ?? {}) }),
    nativeFactoryLoader("opencode.js", "opencodeProvider"),
  ]);

  const codexNative = withContextWindowCap(openaiCodexProvider(), 272_000);
  const codexNativeModels = codexNative.getModels();
  const codex = withPickerIds(
    withExtraModels(codexNative, [
      ...daybreakModels(codexNativeModels),
      ...gpt6CodexModels(codexNativeModels),
    ]),
    CODEX_PICKER_IDS,
  );

  // xAI 의 `xhigh` map 은 pinned 그대로다. grok-4.7 은 catalog 기본 차로다.
  //
  // catalog 는 grok 의 `maxTokens` 를 contextWindow(500k)와 같게 두는데, 그러면 pi 가
  // 매 호출 `max_output_tokens = contextWindow - 현재 컨텍스트 추정 - 4096` 을 보낸다
  // (`simple-options.js clampMaxTokensToContext`). xAI 는 그 값을 프롬프트 캐시 키에
  // 넣어서, 값이 턴마다 바뀌면 접두사가 같아도 전부 miss 다 (2026-09-02 실측:
  // 동일 body 재전송 cached 7808 → max_output_tokens 만 바꾸면 512). 고정 상한을 줘서
  // 컨텍스트가 거의 찰 때까지 같은 값이 나가게 한다.
  const xaiNative = xaiProvider();
  const xai = withPickerIds(
    withMaxTokensCap(withExtraModels(xaiNative, grok47Models(xaiNative.getModels())), XAI_MAX_OUTPUT_TOKENS),
    XAI_PICKER_IDS,
  );

  // Anthropic 은 pinned provider + setup-token fallback resolver 하나다. wire 와
  // tool 이름 규칙은 pin 이 소유한다. Fable 5.1 과 Opus 5.5 만 pin 에 없어
  // 각각 Fable 5·Opus 5 에서 파생한다.
  // 피커는 현재 세대(fable 5.1, opus 5.5, sonnet 5, haiku 4.5)로 줄인다.
  const anthropicBase = withClaudeSetupToken(anthropicProvider(), anthropic ?? { env });
  const anthropicNative = withPickerIds(
    withExtraModels(anthropicBase, [
      ...fable51Models(anthropicBase.getModels()),
      ...opus55Models(anthropicBase.getModels()),
    ]),
    ANTHROPIC_PICKER_IDS,
  );

  if (antigravity && typeof antigravity === "object") {
    Object.assign(antigravity, {
      stateStore: antigravityDirect.stateStore,
      lineage: antigravityDirect.lineage,
    });
  }

  // OpenCode 는 pinned factory 그대로다. Muse Spark 1.3 Contributor Free 는
  // pin catalog 에 이미 있으므로 파생하지 않는다. 피커만 그 모델로 줄인다.
  // 키는 OPENCODE_API_KEY 또는 Keychain `opencode.ai` — `/login` 을 요구하지 않는다.
  const opencode = withOpenCodeKeychain(
    withPickerIds(opencodeProvider(), OPENCODE_PICKER_IDS),
    { env, ...(opencodeOptions ?? {}) },
  );

  const store = speedStore;
  store?.startProbes?.();
  const wrap = (provider) => wrapProviderStreams(withSubAccountCopies(provider), { speedIndexStore: store });

  return [
    wrap(codex),
    wrap(xai),
    wrap(cursorProvider),
    wrap(anthropicNative),
    wrap(withKiroSidecarEnsure(
      kiroNative,
      kiro?.ensureKiro ?? (() => ensureKiroSidecar(env)),
    )),
    wrap(antigravityDirect.provider),
    wrap(opencode),
  ];
}
