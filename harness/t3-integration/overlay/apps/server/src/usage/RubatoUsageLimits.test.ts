// @effect-diagnostics nodeBuiltinImport:off -- the stub Rubato checkout is written with node:fs.
// The Usage page's Rubato rows: `rubato auth usage --json` answered through a stub auth
// module in a temporary checkout, the way the server reaches the real one.
import { assert, it } from "@effect/vitest";
import type { ServerSettings, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUBATO_USAGE_SOURCE_ID, readRubatoUsageSource } from "./RubatoUsageLimits.ts";

const CHECKED_AT = "2026-10-17T18:00:00.000Z";
const window = (id: string, usedPercent: number) => ({ id, kind: "weekly", label: "Weekly", usedPercent });

/** A checkout whose auth service answers `usage` with `answer`, or fails when it is an Error. */
function stubCheckout(answer: unknown): ServerSettings {
  const root = mkdtempSync(join(tmpdir(), "rubato-usage-source-"));
  mkdirSync(join(root, "auth"));
  writeFileSync(join(root, "bridge.mjs"), "export {};\n");
  const body = answer instanceof Error
    ? `throw new Error(${JSON.stringify(answer.message)});`
    : `return ${JSON.stringify(answer)};`;
  writeFileSync(
    join(root, "auth", "service.mjs"),
    `export function authService() { return { async handle(action) { if (action !== "usage") throw new Error("unexpected " + action); ${body} } }; }\n`,
  );
  return {
    providerInstances: { rubato: { driver: "rubato-pi", config: { bridgeModule: join(root, "bridge.mjs") } } },
  } as unknown as ServerSettings;
}

const row = (provider: string, account: string, windows: unknown[], extra: Record<string, unknown> = {}) => ({
  provider,
  account,
  ...extra,
  usageLimits: { checkedAt: CHECKED_AT, windows },
});

it.effect("each Rubato account is its own row under its provider's driver", () =>
  Effect.gen(function* () {
    const source = yield* readRubatoUsageSource(
      stubCheckout({
        accounts: [
          row("openai-codex", "default", [window("primary", 62)], { email: "me@example.com", plan: "ChatGPT Pro" }),
          row("anthropic", "login-2", [window("seven_day", 13)]),
          row("anthropic", "setup-token", [window("seven_day", 72)]),
          row("cursor", "default", [window("totalPercentUsed", 0.1)]),
          row("xai", "default", [window("subscription", 5)]),
          row("google-antigravity", "default", [window("3p-weekly", 0)]),
          row("opengateway", "default", [window("x", 1)]),
          { provider: "anthropic", account: "broken", usageLimits: { windows: [] } },
        ],
      }),
      [],
    );
    assert.ok(source);
    assert.equal(source.id, RUBATO_USAGE_SOURCE_ID);
    assert.equal(source.kind, "rubato");
    assert.equal(source.error, undefined);
    assert.deepEqual(
      source.accounts.map((account) => [account.id, account.driver]),
      [
        ["Codex", "codex"],
        ["Claude · login-2", "claudeAgent"],
        ["Claude · setup-token", "claudeAgent"],
        ["Cursor", "cursor"],
        ["Grok", "grok"],
        ["Antigravity", "antigravity"],
      ],
      "a provider without a T3 driver and a row the page cannot draw are dropped",
    );
    assert.equal(source.accounts[0]?.email, "me@example.com");
    assert.equal(source.accounts[0]?.plan, "ChatGPT Pro");
  }),
);

it.effect("a read that failed this time keeps the account's last good bars", () =>
  Effect.gen(function* () {
    const previous: UsageLimitSourceSnapshot[] = [{
      id: RUBATO_USAGE_SOURCE_ID,
      kind: "rubato",
      label: "Rubato",
      checkedAt: CHECKED_AT,
      accounts: [{
        id: "Claude · login-2",
        driver: "claudeAgent" as never,
        usageLimits: { checkedAt: CHECKED_AT, windows: [window("seven_day", 13) as never] },
      }],
    }];
    const source = yield* readRubatoUsageSource(
      stubCheckout({
        accounts: [{
          provider: "anthropic",
          account: "login-2",
          usageLimits: { checkedAt: CHECKED_AT, windows: [], unavailable: { reason: "probeFailed", message: "rate limited" } },
        }, {
          provider: "anthropic",
          account: "setup-token",
          usageLimits: { checkedAt: CHECKED_AT, windows: [], unavailable: { reason: "probeFailed", message: "no reply yet" } },
        }],
      }),
      previous,
    );
    assert.deepEqual(source?.accounts[0]?.usageLimits.windows.map((entry) => entry.usedPercent), [13]);
    assert.equal(source?.accounts[1]?.usageLimits.unavailable?.reason, "probeFailed", "nothing earlier to keep");
  }),
);

it.effect("a checkout that cannot answer reports why and keeps the rows it had", () =>
  Effect.gen(function* () {
    const previous: UsageLimitSourceSnapshot[] = [{
      id: RUBATO_USAGE_SOURCE_ID,
      kind: "rubato",
      label: "Rubato",
      checkedAt: CHECKED_AT,
      accounts: [{
        id: "Codex",
        driver: "codex" as never,
        usageLimits: { checkedAt: CHECKED_AT, windows: [window("primary", 62) as never] },
      }],
    }];
    const source = yield* readRubatoUsageSource(stubCheckout(new Error("rubato auth exited with 1")), previous);
    assert.match(source?.error ?? "", /rubato auth exited with 1/);
    assert.deepEqual(source?.accounts.map((account) => account.id), ["Codex"]);
  }),
);

it.effect("an environment without a Rubato provider has no Rubato source", () =>
  Effect.gen(function* () {
    assert.equal(yield* readRubatoUsageSource({ providerInstances: {} } as unknown as ServerSettings, []), undefined);
    assert.equal(yield* readRubatoUsageSource(null, []), undefined);
  }),
);
