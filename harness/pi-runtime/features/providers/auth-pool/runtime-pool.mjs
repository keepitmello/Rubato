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

export function wireAccountModel(model) {
  if (typeof model?.id !== "string" || !model.id.endsWith("-sub")) return model;
  return { ...model, id: model.id.slice(0, -4) };
}

export function subAccountName(slots) {
  if (slots.some((slot) => slot.name === "sub")) return "sub";
  return slots.find((slot) => slot.name === "login-2")?.name;
}

export function requiredAccountSlotName(model, slots) {
  const subName = subAccountName(slots);
  if (typeof model?.id === "string" && model.id.endsWith("-sub")) return subName ?? "sub";
  if (!subName) return undefined;
  return slots.find((slot) => slot.name === "setup-token" || slot.lane === "setup-token")?.name
    ?? slots.find((slot) => slot.name !== subName)?.name;
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
        return prepared.provider[method](prepared.model, context, prepared.options);
      },
    });
  }
  const prepared = await runtime.prepareRequest(wire, options);
  return prepared.provider[method](prepared.model, context, prepared.options);
}

export { listSlots };
