// Rubato: the Antigravity accounts as Settings > Providers > Antigravity ACP, the desktop's model
// picker and the phone's thread settings all show them. Accounts are Google logins, and the system
// prompts (agy agents) run on them. One T3 Antigravity instance pairs one agy agent with one login.
// Instances without RUBATO_LOCAL_AGY_ISOLATED all use the login the official agy CLI holds;
// each isolated instance keeps its own Google profile (server RubatoLocalAgy.ts), as does a plain
// T3 Antigravity instance that names no agy agent, unless RUBATO_LOCAL_AGY_LOGIN names the isolated
// instance whose profile it runs on. So the lead and another agent on one login are one account
// with two system prompts, not two accounts.

const LOCAL_AGY_AGENT = "RUBATO_LOCAL_AGY_AGENT";
const LOCAL_AGY_ISOLATED = "RUBATO_LOCAL_AGY_ISOLATED";
export const LOCAL_AGY_LOGIN = "RUBATO_LOCAL_AGY_LOGIN";

// A value may also be a secret reference; only plain strings name an agent or the isolated flag.
type Environment = ReadonlyArray<{ readonly name: string; readonly value: unknown }> | undefined;

export interface AgyInstanceInput {
  readonly displayName?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly environment?: Environment;
}

export interface AgyLiveInput {
  readonly status: string;
  readonly auth?: { readonly status?: string | undefined } | undefined;
  readonly models: ReadonlyArray<{ readonly name: string }>;
}

/** One system prompt: the T3 instance the composer's picker shows as its own group. */
export interface AgyPrompt {
  readonly instanceId: string;
  readonly name: string;
  /** The agy agent (`~/.gemini/config/agents/<agent>.md`) it runs. */
  readonly agent: string | null;
  readonly enabled: boolean;
}

/** connected · checking (no live status yet) · signin (isolated, an agent on it is not signed in) · absent (CLI login not ready) · off */
export type AgyAccountState = "connected" | "checking" | "signin" | "absent" | "off";

export interface AgyAccount {
  /** "agy-cli" for the CLI login; for an isolated login, the instance that holds the sign-in. */
  readonly key: string;
  readonly isolated: boolean;
  /** The isolated login's name; null for the CLI login, which the page names itself. */
  readonly name: string | null;
  readonly state: AgyAccountState;
  readonly models: ReadonlyArray<string>;
  readonly prompts: ReadonlyArray<AgyPrompt>;
}

export const AGY_CLI_ACCOUNT_KEY = "agy-cli";

const valueOf = (environment: Environment, name: string) => {
  const value = environment?.find((entry) => entry.name === name)?.value;
  return typeof value === "string" ? value.trim() : "";
};

/** Its own Google profile: flagged isolated, or a plain T3 Antigravity instance without an agy agent. */
export function isIsolatedAgy(environment: Environment): boolean {
  return !valueOf(environment, LOCAL_AGY_AGENT) || /^(1|true)$/i.test(valueOf(environment, LOCAL_AGY_ISOLATED));
}

/** The isolated instance whose sign-in this one runs on: itself unless it names another. */
export function agyLoginOwner(instanceId: string, environment: Environment): string {
  return valueOf(environment, LOCAL_AGY_LOGIN) || instanceId;
}

function promptOf(instanceId: string, instance: AgyInstanceInput): AgyPrompt {
  return {
    instanceId,
    name: instance.displayName?.trim() || instanceId,
    agent: valueOf(instance.environment, LOCAL_AGY_AGENT) || null,
    enabled: instance.enabled !== false,
  };
}

function modelsOf(prompts: ReadonlyArray<AgyPrompt>, live: ReadonlyMap<string, AgyLiveInput>): string[] {
  for (const prompt of prompts) {
    const models = live.get(prompt.instanceId)?.models ?? [];
    if (prompt.enabled && models.length > 0) return models.map((model) => model.name);
  }
  return [];
}

function cliState(prompts: ReadonlyArray<AgyPrompt>, live: ReadonlyMap<string, AgyLiveInput>): AgyAccountState {
  const enabled = prompts.filter((prompt) => prompt.enabled);
  if (enabled.length === 0) return "off";
  if (enabled.some((prompt) => live.get(prompt.instanceId)?.status === "ready")) return "connected";
  if (enabled.some((prompt) => !live.has(prompt.instanceId))) return "checking";
  return "absent";
}

// The agents on one isolated login share its stored sign-in, but each instance keeps its own sign-in
// state. An agent that found the login signed out speaks for the whole login, so the row never says
// connected while that agent cannot run.
function isolatedState(
  holder: AgyPrompt,
  prompts: ReadonlyArray<AgyPrompt>,
  live: ReadonlyMap<string, AgyLiveInput>,
): AgyAccountState {
  if (!holder.enabled) return "off";
  const views = prompts.filter((prompt) => prompt.enabled).map((prompt) => live.get(prompt.instanceId));
  if (views.some((view) => view?.auth?.status === "unauthenticated")) return "signin";
  return views.some((view) => view?.auth?.status === "authenticated" || view?.status === "ready")
    ? "connected"
    : "signin";
}

/**
 * The holder's status for the login's sign-in controls. When another agent on the login found it
 * signed out, the holder's own "signed in" would hide the way to sign in again.
 */
export function agySignInView<Live extends { readonly auth: { readonly status: string } }>(
  account: Pick<AgyAccount, "state">,
  live: Live,
): Live {
  return account.state === "signin" && live.auth.status === "authenticated"
    ? ({ ...live, auth: { ...live.auth, status: "unauthenticated" } } as Live)
    : live;
}

/** The CLI login first (when any instance uses it), then each isolated login in the given order. */
export function agyAccounts(
  entries: ReadonlyArray<readonly [string, AgyInstanceInput]>,
  live: ReadonlyMap<string, AgyLiveInput>,
): ReadonlyArray<AgyAccount> {
  const cli = entries.filter(([, instance]) => !isIsolatedAgy(instance.environment)).map(([id, i]) => promptOf(id, i));
  const accounts: AgyAccount[] = [];
  if (cli.length > 0) {
    accounts.push({
      key: AGY_CLI_ACCOUNT_KEY,
      isolated: false,
      name: null,
      state: cliState(cli, live),
      models: modelsOf(cli, live),
      prompts: cli,
    });
  }
  // Each isolated login, at its first instance; the owner's prompt leads it and names it.
  const logins = new Map<string, { owner: AgyPrompt | undefined; prompts: AgyPrompt[] }>();
  for (const [id, instance] of entries) {
    if (!isIsolatedAgy(instance.environment)) continue;
    const key = agyLoginOwner(id, instance.environment);
    const login = logins.get(key) ?? { owner: undefined, prompts: [] };
    const prompt = promptOf(id, instance);
    if (id === key) login.owner = prompt;
    else login.prompts.push(prompt);
    logins.set(key, login);
  }
  for (const [key, login] of logins) {
    const prompts = login.owner ? [login.owner, ...login.prompts] : login.prompts;
    const holder = login.owner ?? prompts[0]!;
    accounts.push({
      key,
      isolated: true,
      name: holder.name,
      state: isolatedState(holder, prompts, live),
      models: modelsOf(prompts, live),
      prompts,
    });
  }
  return accounts;
}

/** The nav line's numbers. A login still being checked counts as connected, as its row says "Checking…". */
export function agyAccountsSummary(accounts: ReadonlyArray<AgyAccount>): {
  readonly connected: number;
  readonly total: number;
  readonly off: boolean;
} {
  return {
    connected: accounts.filter((account) => account.state === "connected" || account.state === "checking").length,
    total: accounts.length,
    off: accounts.length > 0 && accounts.every((account) => account.state === "off"),
  };
}

export interface AgyPickerAgent {
  readonly instanceId: string;
  readonly label: string;
}

export interface AgyPickerAccount {
  /** The instance that stands for the login in a picker: the login's lead when it has one. */
  readonly railId: string;
  readonly label: string;
  readonly agents: ReadonlyArray<AgyPickerAgent>;
}

const LEAD_AGENT = "rubato-lead";

type PickerInstances = Readonly<Record<string, (AgyInstanceInput & { readonly driver?: unknown }) | undefined>>;

/**
 * The logins among the instances a picker shows, in the picker's order. Pickers show each login
 * once, and the agents on it are a choice above its models, the lead first as "Rubato".
 */
export function agyPickerAccounts(
  instances: PickerInstances | undefined,
  shownIds: ReadonlyArray<string>,
): ReadonlyArray<AgyPickerAccount> {
  const entries = shownIds.flatMap((id) => {
    const instance = instances?.[id];
    return instance?.driver === "antigravity" ? [[id, instance] as const] : [];
  });
  return agyAccounts(entries, new Map()).flatMap((account) => {
    const agents = account.prompts
      .map((prompt) => ({
        instanceId: prompt.instanceId,
        label: prompt.agent === LEAD_AGENT ? "Rubato" : (prompt.agent ?? prompt.name),
        lead: prompt.agent === LEAD_AGENT,
      }))
      // .sort() on a fresh array keeps the settings order among the rest.
      .sort((left, right) => Number(right.lead) - Number(left.lead))
      .map(({ instanceId, label }) => ({ instanceId, label }));
    if (agents.length === 0) return [];
    return [
      {
        railId: agents[0]!.instanceId,
        label: account.isolated ? (account.name ?? "Antigravity") : "Antigravity",
        agents,
      },
    ];
  });
}
