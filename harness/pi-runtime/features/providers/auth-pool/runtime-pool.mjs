import { dirname, join } from "node:path";
import { sessionAffinityStore, readSessionBinding } from "./affinity.mjs";
import { discoverEnvSlots } from "./env-slots.mjs";
import { discoverSetupTokenSlots } from "./setup-token-slots.mjs";
import { listSlots } from "./slots.mjs";
import { CredentialSlotRepository } from "./state-store.mjs";
import { listRotationSlots, streamWithCredentialRotation } from "./rotation-stream.mjs";
import { serverRetryAfterMs } from "./classify.mjs";
import { createUsageObserver, observesUsage, usageObservedPath } from "./usage-observed.mjs";
import { accountLaneSlotNames } from "./account-lanes.mjs";
import { createQuotaUsageReader } from "./quota-usage.mjs";
import { readAccountLoadBalancing } from "../provider-switch.mjs";
export { accountLaneSlotNames };

function poolStatePathFor(runtime) {
  const authPath = runtime.credentials?.store?.authPath;
  if (typeof authPath === "string" && authPath.length > 0) return join(dirname(authPath), "credential-pool-state.json");
  return undefined;
}

function usageObserverFor(runtime) {
  if (runtime._rubatoUsageObserver !== undefined) return runtime._rubatoUsageObserver;
  const authPath = runtime.credentials?.store?.authPath;
  runtime._rubatoUsageObserver = typeof authPath === "string" && authPath.length > 0
    ? createUsageObserver({ path: usageObservedPath(authPath) })
    : null;
  return runtime._rubatoUsageObserver;
}

function envLookup(options) {
  return (name) => options?.env?.[name] ?? process.env[name];
}

function storedCredentialSync(runtime, providerId) {
  return runtime.credentials?.store?.readState?.data?.[providerId];
}

function mightHoldCredentialPool(providerId, credential, env, policySlots) {
  const accounts = credential?.accounts;
  if (Array.isArray(accounts) && accounts.length > 1) return true;
  if (Object.keys(policySlots ?? {}).length > 0) return true;
  if (discoverEnvSlots(providerId, env).length > 1) return true;
  return providerId === "anthropic";
}

export function couldRotateCredentials(runtime, model, options) {
  if (options?.apiKey !== undefined) return false;
  if (runtime.credentials?.hasRuntimeApiKey?.(model.provider)) return false;
  if (runtime.config?.getProvider?.(model.provider)?.credentials?.rotation === false) return false;
  const env = envLookup(options);
  if (runtime.snapshot?.storedProviders?.has(model.provider)) return true;
  if (storedCredentialSync(runtime, model.provider)) return true;
  const policySlots = runtime.config?.getProvider?.(model.provider)?.credentials?.slots;
  if (model.provider === "anthropic") return true;
  return discoverEnvSlots(model.provider, env).length + Object.keys(policySlots ?? {}).length > 1;
}

export async function credentialRotationSources(runtime, model, options) {
  const env = envLookup(options);
  const credential = await runtime.credentials.read(model.provider, { signal: options?.signal });
  const policy = runtime.config?.getProvider?.(model.provider)?.credentials;
  if (!mightHoldCredentialPool(model.provider, credential, env, policy?.slots)) return undefined;
  const repository = runtime._rubatoPoolRepository ?? (runtime._rubatoPoolRepository = new CredentialSlotRepository(poolStatePathFor(runtime)));
  const sources = {
    providerId: model.provider,
    credential,
    env,
    repository,
    policy,
    discoverExtraSlots: () => discoverSetupTokenSlots(model.provider, env, { signal: options?.signal }),
  };
  const slots = await listRotationSlots(sources);
  const sessionId = options?.sessionId ?? options?.affinityKey;
  const existing = model.provider === "anthropic" && sessionId
    ? await readSessionBinding(sessionAffinityStore(runtime), repository, model.provider, sessionId)
    : undefined;
  if (slots.length <= 1 && accountLaneOf(model) < 0
    && !existing && !(model.provider === "anthropic" && sessionId && slots.length === 1)) return undefined;
  sources.loadBalancing = model.provider === "anthropic" && accountLaneOf(model) < 0
    && readAccountLoadBalancing({ home: env("HOME") }).has(model.provider);
  if (sources.loadBalancing && !sessionId) throw new Error("Account load balancing requires a session id.");
  if (sources.loadBalancing && slots.length > 1 && !credential?.pinned && !existing) {
    const authPath = runtime.credentials?.store?.authPath;
    const readUsage = runtime._rubatoQuotaUsage ??= createQuotaUsageReader({
      path: typeof authPath === "string" ? usageObservedPath(authPath) : undefined,
    });
    sources.quotaUsage = await readUsage(credential, options?.signal);
    sources.modelId = wireAccountModel(model).id;
  }
  return sources;
}

function slotRequestOptions(options, slot) {
  if (slot.lane === "env" || slot.lane === "setup-token") return { ...options, apiKey: slot.envKey, slotName: undefined };
  return { ...options, slotName: slot.name };
}

/**
 * 이 시도의 429 응답 헤더를 받을 콜백을 요청 옵션에 싣는다.
 *
 * SDK 는 429 를 예외로 던지고 엔진은 그 메시지 문자열만 남긴다 — "언제 풀린다"는 응답 헤더는
 * 계정 쉬는 시간을 정하는 자리까지 오지 못한다. 헤더를 보는 곳은 fetch 뿐이라, fetch 를 고르는
 * rubato-stream 이 `onRateLimitResponse` 로 헤더를 건넨다. 여기서 fetch 를 직접 갈면 그쪽이
 * 고르는 연결 풀을 건너뛰고, Google 계열은 바뀐 fetch 를 거절한다.
 */
export function withRateLimitObserver(prepared, onRetryAfterMs, now = Date.now) {
  return {
    ...prepared,
    options: {
      ...prepared?.options,
      onRateLimitResponse: (headers) => {
        const ms = serverRetryAfterMs(headers, now());
        if (ms !== undefined) onRetryAfterMs(ms);
      },
    },
  };
}

/**
 * 이 시도의 응답 헤더를 계정 이름과 함께 사용량 관측(usage-observed.mjs)으로 넘긴다.
 * 어느 계정이 답했는지 아는 곳이 여기뿐이라 rubato-stream 은 헤더만 건넨다.
 */
export function withUsageObserver(prepared, providerId, accountName, observe) {
  if (!observe || !accountName || !observesUsage(providerId)) return prepared;
  return {
    ...prepared,
    options: {
      ...prepared?.options,
      onResponseHeaders: (headers) => observe(providerId, accountName, headers),
    },
  };
}

/** 계정 묶음을 돌지 않는 요청이 쓰는 계정. 저장된 계정이 하나면 그것, 없으면 setup-token. */
function singleAccountName(runtime, providerId, options) {
  if (options?.apiKey !== undefined) return undefined;
  const stored = storedCredentialSync(runtime, providerId);
  if (stored) {
    const slots = listSlots(stored);
    return typeof stored.pinned === "string" ? stored.pinned : slots.length === 1 ? slots[0].name : undefined;
  }
  return providerId === "anthropic" ? "setup-token" : undefined;
}

// 계정 행 꼬리. 순서가 곧 계정 순서다: `-sub` 는 두 번째, `-sub2` 는 세 번째 계정.
// 꼬리 목록은 packages/model-core/src/product-model-catalog.mjs `ACCOUNT_LANE_SUFFIXES` 와 같다.
const ACCOUNT_LANES = Object.freeze([
  Object.freeze({ suffix: "-sub", fallback: "sub" }),
  Object.freeze({ suffix: "-sub2", fallback: "sub2" }),
]);

function accountLaneOf(model) {
  const id = model?.id;
  if (typeof id !== "string") return -1;
  return ACCOUNT_LANES.findIndex((lane) => id.endsWith(lane.suffix));
}

export function wireAccountModel(model) {
  const lane = accountLaneOf(model);
  if (lane < 0) return model;
  return { ...model, id: model.id.slice(0, -ACCOUNT_LANES[lane].suffix.length) };
}

export function subAccountName(slots) {
  return accountLaneSlotNames(slots)[0];
}

export function requiredAccountSlotName(model, slots) {
  const laneNames = accountLaneSlotNames(slots);
  const lane = accountLaneOf(model);
  if (lane >= 0) return laneNames[lane] ?? ACCOUNT_LANES[lane].fallback;
  if (laneNames.length === 0) return undefined;
  return slots.find((slot) => slot.name === "setup-token" || slot.lane === "setup-token")?.name
    ?? slots.find((slot) => !laneNames.includes(slot.name))?.name;
}

export async function streamWithCredentialPool(runtime, method, model, context, options) {
  const streamOptions = options;
  const wire = wireAccountModel(model);
  const sources = couldRotateCredentials(runtime, model, streamOptions)
    ? await credentialRotationSources(runtime, model, streamOptions)
    : undefined;
  if (sources) {
    const slots = await listRotationSlots(sources);
    const retryAfterBySlot = new Map();
    return streamWithCredentialRotation({
      sources,
      affinityStore: sessionAffinityStore(runtime),
      requiredSlotName: streamOptions?.slotName ?? (accountLaneOf(model) >= 0
        ? requiredAccountSlotName(model, slots)
        : sources.loadBalancing || sources.credential?.pinned ? undefined : requiredAccountSlotName(model, slots)),
      explicitSlotName: streamOptions?.slotName ?? (accountLaneOf(model) >= 0 ? requiredAccountSlotName(model, slots) : undefined),
      serverRetryAfterMs: (slot) => retryAfterBySlot.get(slot?.name),
      ...(streamOptions?.sessionId !== undefined
        ? { affinityKey: streamOptions.sessionId }
        : streamOptions?.affinityKey !== undefined
          ? { affinityKey: streamOptions.affinityKey }
          : {}),
      runAttempt: async (slot) => {
        retryAfterBySlot.delete(slot.name);
        const prepared = await runtime.prepareRequest(wire, slotRequestOptions(streamOptions, slot));
        const observed = withUsageObserver(
          withRateLimitObserver(prepared, (ms) => retryAfterBySlot.set(slot.name, ms)),
          model.provider,
          slot.name,
          usageObserverFor(runtime),
        );
        return callProviderStream(observed, method, context, runtime);
      },
    });
  }
  const prepared = await runtime.prepareRequest(wire, options);
  const observed = withUsageObserver(
    prepared,
    model.provider,
    singleAccountName(runtime, model.provider, options),
    usageObserverFor(runtime),
  );
  return callProviderStream(observed, method, context, runtime);
}

export { listSlots };

const SPEED_WRAP = Symbol.for("rubato.stream.decorated");
let speedWrap;

async function loadSpeedWrap() {
  if (speedWrap !== undefined) return speedWrap;
  try {
    speedWrap = await import("../src/rubato-stream.mjs");
  } catch {
    speedWrap = null;
  }
  return speedWrap;
}

// Direct providers are already wrapped. Custom registrations (b-ai, models.json)
// reach this pool unwrapped, so every model call records here when a store is bound.
export function invokeProviderStream(prepared, method, context, store, wrap) {
  const provider = prepared?.provider;
  const source = provider?.[method];
  if (typeof source !== "function") {
    throw new TypeError(`Provider has no ${method}`);
  }
  const stream = store && wrap && !provider[SPEED_WRAP]
    ? wrap(source, store)
    : source;
  return stream.call(provider, prepared.model, context, prepared.options);
}

async function callProviderStream(prepared, method, context, runtime) {
  const wrapModule = runtime?.speedIndexStore ? await loadSpeedWrap() : null;
  const wrap = wrapModule
    ? (source, store) => wrapModule.withRubatoStream(source, { speedIndexStore: store })
    : null;
  return invokeProviderStream(prepared, method, context, runtime?.speedIndexStore, wrap);
}
