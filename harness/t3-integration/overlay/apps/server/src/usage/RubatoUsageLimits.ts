// @effect-diagnostics nodeBuiltinImport:off -- the Rubato checkout is a plain module path, as in RubatoServiceRoute.ts.
/**
 * The Usage page's Rubato rows: subscription usage for every account Rubato holds,
 * one row per account under that provider's own icon.
 *
 * T3's own drivers read quota through each vendor CLI's login, and Rubato's are off. Rubato
 * keeps its accounts itself (`rubato auth`), so they arrive the way a CLIProxyAPI hub's do:
 * as a usage-limit source whose accounts name the provider they belong to. The reading
 * happens in the Rubato checkout (`rubato auth usage --json`, harness/scripts/rubato-usage.mjs)
 * reached through the same auth service the Providers settings page uses.
 *
 * @module usage/RubatoUsageLimits
 */
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  ProviderDriverKind,
  UsageLimitSourceAccount,
  type ServerSettings,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const RUBATO_USAGE_SOURCE_ID = "rubato" as UsageLimitSourceId;

/** Rubato provider id → the T3 driver whose icon and colour the row borrows, and its name. */
const PROVIDERS: Readonly<Record<string, { readonly driver: string; readonly label: string }>> = {
  "openai-codex": { driver: "codex", label: "Codex" },
  anthropic: { driver: "claudeAgent", label: "Claude" },
  cursor: { driver: "cursor", label: "Cursor" },
  xai: { driver: "grok", label: "Grok" },
  "google-antigravity": { driver: "antigravity", label: "Antigravity" },
};

interface RubatoUsageRow {
  readonly provider?: unknown;
  readonly account?: unknown;
  readonly email?: unknown;
  readonly plan?: unknown;
  readonly usageLimits?: unknown;
}

interface AuthService {
  readonly handle: (action: string, input?: unknown) => Promise<unknown>;
}

const decodeAccount = Schema.decodeUnknownOption(UsageLimitSourceAccount);

/** The checkout the Rubato provider runs from, or undefined when no Rubato provider is set up. */
function bridgeModuleOf(settings: ServerSettings | null): string | undefined {
  for (const instance of Object.values(settings?.providerInstances ?? {})) {
    if (instance.driver !== "rubato-pi" || !instance.config || typeof instance.config !== "object") continue;
    const bridge = (instance.config as { readonly bridgeModule?: unknown }).bridgeModule;
    if (typeof bridge === "string" && NodePath.isAbsolute(bridge)) return bridge;
  }
  return undefined;
}

async function readUsage(bridgeModule: string): Promise<unknown> {
  const file = NodePath.join(NodePath.dirname(bridgeModule), "auth", "service.mjs");
  const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    readonly authService?: () => AuthService;
  };
  if (typeof module.authService !== "function") throw new Error("Invalid Rubato auth module");
  return module.authService().handle("usage");
}

/** One stable row id per account: the provider's name, and the account's when it is not the only one. */
export function rubatoAccountId(provider: string, account: string): string {
  const label = PROVIDERS[provider]?.label ?? provider;
  return account === "default" ? label : `${label} · ${account}`;
}

/** `rubato auth usage --json` → the source's accounts. Rows this build cannot draw are dropped. */
export function rubatoUsageAccounts(answer: unknown): ReadonlyArray<UsageLimitSourceAccount> {
  const rows = (answer as { readonly accounts?: unknown })?.accounts;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: RubatoUsageRow) => {
    if (typeof row?.provider !== "string" || typeof row.account !== "string") return [];
    const provider = PROVIDERS[row.provider];
    if (!provider) return [];
    const decoded = decodeAccount({
      id: rubatoAccountId(row.provider, row.account),
      driver: ProviderDriverKind.make(provider.driver),
      ...(typeof row.email === "string" && row.email.trim() ? { email: row.email } : {}),
      ...(typeof row.plan === "string" && row.plan.trim() ? { plan: row.plan } : {}),
      usageLimits: row.usageLimits,
    });
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
}

/**
 * A read that failed this time keeps the account's last good bars: a lapsed token or a
 * rate-limited usage endpoint says nothing new about the quota.
 */
export function keepLastGoodReads(
  next: ReadonlyArray<UsageLimitSourceAccount>,
  previous: ReadonlyArray<UsageLimitSourceAccount>,
): ReadonlyArray<UsageLimitSourceAccount> {
  return next.map((account) => {
    if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
    const last = previous.find((candidate) => candidate.id === account.id);
    return last && last.usageLimits.windows.length > 0 && !last.usageLimits.unavailable ? last : account;
  });
}

/**
 * The Rubato source's next snapshot, or undefined when this environment has no Rubato
 * provider. Never fails: a failed read keeps the previous accounts beside its error.
 */
export const readRubatoUsageSource = Effect.fn("readRubatoUsageSource")(function* (
  settings: ServerSettings | null,
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
): Effect.fn.Return<UsageLimitSourceSnapshot | undefined> {
  const bridgeModule = bridgeModuleOf(settings);
  if (!bridgeModule) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const before = previous.find((source) => source.id === RUBATO_USAGE_SOURCE_ID)?.accounts ?? [];
  const base = { id: RUBATO_USAGE_SOURCE_ID, kind: "rubato", label: "Rubato", checkedAt } as const;
  const answer = yield* Effect.tryPromise(() => readUsage(bridgeModule)).pipe(Effect.result);
  if (answer._tag === "Failure") {
    const cause = answer.failure.cause;
    return {
      ...base,
      accounts: before,
      error: `Could not read Rubato usage: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  return {
    ...base,
    accounts: keepLastGoodReads(rubatoUsageAccounts(answer.success), before),
  };
});
