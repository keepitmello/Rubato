// The Usage page's subscription bars for Rubato's own accounts. T3 reads quota through each
// vendor CLI's login, and Rubato runs on its own credentials instead, so the bars were empty.
// Rubato's accounts join as a usage-limit source of kind "rubato" beside any CLIProxyAPI hub:
// one row per account under that provider's icon, read by `rubato auth usage --json`
// (overlay/apps/server/src/usage/RubatoUsageLimits.ts, harness/scripts/rubato-usage.mjs).
export const usageLimitsOverlays = [
  'apps/server/src/usage/RubatoUsageLimits.ts',
  'apps/server/src/usage/RubatoUsageLimits.test.ts',
];

export const usageLimitsEdits = {
  'packages/contracts/src/providerUsageLimits.ts': [
    [
      'export const UsageLimitSourceSnapshot = Schema.Struct({\n  id: UsageLimitSourceId,\n  kind: Schema.Literal("cliproxy"),',
      'export const UsageLimitSourceSnapshot = Schema.Struct({\n  id: UsageLimitSourceId,\n  kind: Schema.Literals(["cliproxy", "rubato"]),',
      'replace',
    ],
  ],
  'apps/server/src/usage/UsageLimitSources.ts': [
    ['import { makeCliproxyApi } from "./cliproxyApi.ts";', 'import { readRubatoUsageSource } from "./RubatoUsageLimits.ts";\n'],
    [
      '    yield* publish(snapshots);\n  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));',
      [
        '    // Rubato\'s own accounts, beside any configured hub (RubatoUsageLimits.ts).',
        '    const rubato = yield* readRubatoUsageSource(settings, yield* Ref.get(stateRef));',
        '    yield* publish(rubato ? [...snapshots, rubato] : snapshots);',
        '  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));',
      ].join('\n'),
      'replace',
    ],
  ],
  'packages/shared/src/usageLimits.ts': [
    ['        sourceLabel: "CLI Proxy",', '        sourceLabel: source.kind === "rubato" ? "Rubato" : "CLI Proxy",', 'replace'],
  ],
};
