import { dirname, join } from "node:path";
import { sessionAffinityStore } from "./affinity.mjs";
import { discoverEnvSlots } from "./env-slots.mjs";
import { discoverSetupTokenSlots } from "./setup-token-slots.mjs";
import { listSlots } from "./slots.mjs";
import { CredentialSlotRepository } from "./state-store.mjs";
import { listRotationSlots, streamWithCredentialRotation } from "./rotation-stream.mjs";

function poolStatePathFor(runtime) {
  const authPath = runtime.credentials?.store?.authPath;
  if (typeof authPath === "string" && authPath.length > 0) return join(dirname(authPath), "credential-pool-state.json");
  return undefined;
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
  const slots = await listRotationSlots(sources, { acquireLeases: false });
  return slots.length > 1 ? sources : undefined;
}

function slotRequestOptions(options, slot) {
  if (slot.lane === "env" || slot.lane === "setup-token") return { ...options, apiKey: slot.envKey, slotName: undefined };
  return { ...options, slotName: slot.name };
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

/**
 * 기본 계정 다음 계정들의 슬롯 이름. 순서가 곧 행 꼬리다: 0번은 `-sub`, 1번은 `-sub2`.
 * `sub`·`sub2` 로 이름 붙인 슬롯이 먼저고, 로그인이 붙인 `login-N` 은 번호 순서로 뒤에 선다.
 * rubato-pi/src/picker-catalog.mjs `accountLaneSlotNames` 와 같은 규칙이다 — 하나를 바꾸면 둘 다 바꾼다.
 */
export function accountLaneSlotNames(slots) {
  const names = slots.map((slot) => slot.name);
  const named = ["sub", "sub2"].filter((name) => names.includes(name));
  const logins = names
    .filter((name) => /^login-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  return [...named, ...logins];
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
    const slots = await listRotationSlots(sources, { acquireLeases: false });
    return streamWithCredentialRotation({
      sources,
      affinityStore: sessionAffinityStore(runtime),
      requiredSlotName: requiredAccountSlotName(model, slots),
      ...(streamOptions?.affinityKey !== undefined
        ? { affinityKey: streamOptions.affinityKey }
        : streamOptions?.sessionId !== undefined
          ? { affinityKey: streamOptions.sessionId }
          : {}),
      runAttempt: async (slot) => {
        const prepared = await runtime.prepareRequest(wire, slotRequestOptions(streamOptions, slot));
        return callProviderStream(prepared, method, context, runtime);
      },
    });
  }
  const prepared = await runtime.prepareRequest(wire, options);
  return callProviderStream(prepared, method, context, runtime);
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
