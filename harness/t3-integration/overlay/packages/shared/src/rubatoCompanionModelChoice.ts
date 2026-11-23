// Rubato: which models the Add Companion flow offers (intent companion-agy-parity rev 2).
//
// A new companion runs on Rubato's default unless the person opts into Gemini on one of their own
// Antigravity accounts. Only local official agy accounts qualify: an Antigravity instance whose
// environment names an agy agent (RUBATO_LOCAL_AGY_AGENT, server RubatoLocalAgy.ts), enabled and
// not failing (ready, or a warning the composer's picker also still offers). Opting in starts on
// Gemini 4 Hydrogen at its catalog default effort; any other Gemini
// model of those accounts is an explicit pick. The desktop's settings page and the phone's "+"
// both read this, and both send the same create body:
//
// An account is a Google login, not an instance. Every instance without RUBATO_LOCAL_AGY_ISOLATED
// uses the one login the agy CLI holds, whatever agy agent (system prompt) it names, and a
// companion runs only that login with its own prompt (pi-server companion-agy.mjs). So those
// instances are offered once, as "Antigravity", through the first that qualifies.
//
//   Rubato default        → {}                                     (the request as before)
//   Gemini on an account  → { modelSelection: { instanceId, model } }
//
// The selection carries no options: the Mac refuses them (harness/companion/registry.mjs
// validModelSelection), and the account's catalog default effort applies.
import type { ServerProvider, ServerSettings } from "@t3tools/contracts";

export const COMPANION_GEMINI_DEFAULT_MODEL = "gemini-4-hydrogen";
const LOCAL_AGY_AGENT = "RUBATO_LOCAL_AGY_AGENT";
const LOCAL_AGY_ISOLATED = "RUBATO_LOCAL_AGY_ISOLATED";
/** What the pickers call the login the official agy CLI holds. */
export const AGY_CLI_ACCOUNT_LABEL = "Antigravity";

export interface CompanionModelSelection {
  readonly instanceId: string;
  readonly model: string;
}

export interface CompanionModelAccount {
  readonly instanceId: string;
  /** The account's name as the pickers show it: its display name, else its id. */
  readonly label: string;
  /** Its Gemini models in catalog order. */
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  /** Gemini 4 Hydrogen when the account lists it; null makes the person pick (no silent other model). */
  readonly defaultModel: string | null;
}

type ProviderSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "installed" | "status" | "availability" | "displayName"
> & { readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }> };
type InstanceSettings = ServerSettings["providerInstances"] | undefined;

const isGemini = (slug: string) => /^gemini-/i.test(slug);

function environmentValue(instances: InstanceSettings, instanceId: string, name: string): string | null {
  const environment = (instances as Record<string, { readonly environment?: unknown } | undefined> | undefined)?.[instanceId]
    ?.environment;
  if (!Array.isArray(environment)) return null;
  const entry = environment.find(
    (item): item is { name: string; value: string } =>
      typeof item === "object" && item !== null && item.name === name && typeof item.value === "string",
  );
  return entry?.value.trim() || null;
}

/** The accounts a new companion may run Gemini on, in the order the Mac lists its providers. */
export function companionModelAccounts(
  providers: ReadonlyArray<ProviderSnapshot>,
  instances: InstanceSettings,
): ReadonlyArray<CompanionModelAccount> {
  const accounts: CompanionModelAccount[] = [];
  let cliLoginOffered = false;
  for (const provider of providers) {
    if (provider.driver !== "antigravity" || !provider.enabled || provider.installed === false) continue;
    if ((provider.status !== "ready" && provider.status !== "warning") || provider.availability === "unavailable") continue;
    if (environmentValue(instances, provider.instanceId, LOCAL_AGY_AGENT) === null) continue;
    const isolated = /^(1|true)$/i.test(environmentValue(instances, provider.instanceId, LOCAL_AGY_ISOLATED) ?? "");
    if (!isolated && cliLoginOffered) continue;
    const models = provider.models
      .filter((model) => isGemini(model.slug))
      .map((model) => ({ slug: model.slug, name: model.name }));
    if (models.length === 0) continue;
    if (!isolated) cliLoginOffered = true;
    accounts.push({
      instanceId: provider.instanceId,
      label: isolated ? provider.displayName?.trim() || provider.instanceId : AGY_CLI_ACCOUNT_LABEL,
      models,
      defaultModel: models.find(({ slug }) => slug === `${COMPANION_GEMINI_DEFAULT_MODEL}-medium`)?.slug ??
        models.find(({ slug }) => slug === COMPANION_GEMINI_DEFAULT_MODEL)?.slug ?? null,
    });
  }
  return accounts;
}

/** What opting into Gemini starts on: the first account that lists Hydrogen, else that account with no model yet. */
export function companionGeminiStart(
  accounts: ReadonlyArray<CompanionModelAccount>,
): { readonly instanceId: string; readonly model: string | null } | null {
  const account = accounts.find((item) => item.defaultModel !== null) ?? accounts[0];
  return account ? { instanceId: account.instanceId, model: account.defaultModel } : null;
}

/** Whether `selection` is one the flow offers now; anything else is not sent. */
export function isOfferedCompanionModel(
  accounts: ReadonlyArray<CompanionModelAccount>,
  selection: CompanionModelSelection | null,
): boolean {
  if (selection === null) return true;
  return accounts.some(
    (account) =>
      account.instanceId === selection.instanceId && account.models.some((model) => model.slug === selection.model),
  );
}

/** The create request's body: nothing for Rubato's default, else the two routing fields. */
export function companionCreateBody(
  selection: CompanionModelSelection | null,
): { readonly modelSelection?: CompanionModelSelection } {
  return selection === null ? {} : { modelSelection: { instanceId: selection.instanceId, model: selection.model } };
}
