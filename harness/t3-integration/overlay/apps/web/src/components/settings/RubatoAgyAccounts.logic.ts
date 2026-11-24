// Settings > Providers > Antigravity ACP: accounts are Google logins, and the system prompts
// (agy agents) run on them. One T3 Antigravity instance pairs one agy agent with one login.
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

/** connected · checking (no live status yet) · signin (isolated, not signed in) · absent (CLI login not ready) · off */
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

function isolatedState(prompt: AgyPrompt, live: AgyLiveInput | undefined): AgyAccountState {
  if (!prompt.enabled) return "off";
  return live?.auth?.status === "authenticated" || live?.status === "ready" ? "connected" : "signin";
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
      state: isolatedState(holder, live.get(holder.instanceId)),
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
