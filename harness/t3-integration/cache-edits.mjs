// The context ring shows the prompt cache. The bridge adds `cache` to the usage snapshot
// (events.mjs cacheFrom); these edits let it through the contract and the web reader,
// turn the ring red when the cache is cold, and put the cache facts and the thread's own
// warmer switch in the ring's popover where the auto-compaction note used to be. The
// switch posts to /rubato/cache-warming, which the bridge answers (bridge.mjs).
export const cacheOverlays = [
  'apps/server/src/RubatoCacheWarming.ts',
  'apps/web/src/state/rubatoCacheWarming.ts',
  'apps/web/src/components/chat/RubatoCacheSection.tsx',
  'apps/web/src/components/chat/RubatoCacheSection.test.tsx',
];

export const cacheEdits = {
  'packages/contracts/src/providerRuntime.ts': [
    [
      'export const ThreadTokenUsageSnapshot = Schema.Struct({',
      [
        '/** Rubato: the prompt cache behind the context ring. Times are epoch ms. */',
        'export const RubatoCacheSnapshot = Schema.Struct({',
        '  state: Schema.Literals(["warm", "cold", "unknown"]),',
        '  sessionId: Schema.optional(Schema.String),',
        '  hitPercent: Schema.optional(NonNegativeInt),',
        '  expiresAt: Schema.optional(NonNegativeInt),',
        '  warming: Schema.Struct({',
        '    mode: Schema.Literals(["off", "idle", "streaming"]),',
        '    enabled: Schema.Boolean,',
        '    hours: Schema.optional(NonNegativeInt),',
        '    active: Schema.Boolean,',
        '    until: Schema.optional(NonNegativeInt),',
        '  }),',
        '});',
        'export type RubatoCacheSnapshot = typeof RubatoCacheSnapshot.Type;',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  speedIndex: Schema.optional(NonNegativeInt),\n  compactsAutomatically: Schema.optional(Schema.Boolean),',
      '  speedIndex: Schema.optional(NonNegativeInt),\n  cache: Schema.optional(RubatoCacheSnapshot),\n  compactsAutomatically: Schema.optional(Schema.Boolean),',
      'replace',
    ],
  ],
  'apps/web/src/lib/contextWindow.ts': [
    [
      '      speedIndex: asFiniteNumber(payload?.speedIndex),\n',
      '      speedIndex: asFiniteNumber(payload?.speedIndex),\n      cache: (asRecord(payload?.cache) as ThreadTokenUsageSnapshot["cache"] | null) ?? null,\n',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/ContextWindowMeter.tsx': [
    [
      'import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";\n',
      'import { RubatoCacheSection, rubatoCacheIsCold, useRubatoCacheNow } from "./RubatoCacheSection";\n',
      'replace',
    ],
    [
      'import { composerFloatingLayerProps } from "./composerEventScope";\n',
      'import { composerFloatingLayerProps } from "./composerEventScope";\nimport type { EnvironmentId } from "@t3tools/contracts";\n',
      'replace',
    ],
    [
      '  compactDisabledReason?: string | null | undefined;\n}) {\n  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;',
      '  compactDisabledReason?: string | null | undefined;\n  environmentId?: EnvironmentId | undefined;\n}) {\n  const { usage, onCompact, compactDisabled, compactDisabledReason, environmentId } = props;',
      'replace',
    ],
    [
      [
        '  const isOverloaded = normalizedPercentage > 90;',
        '  const usageColor = isOverloaded',
        '    ? "var(--color-error)"',
        '    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";',
        '',
      ].join('\n'),
      [
        '  const usageColor = "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";',
        '  // Rubato: red means one thing, a cold prompt cache (a full context compacts on its',
        '  // own). The track turns too, since a nearly empty context leaves almost no arc to see.',
        '  const cacheNow = useRubatoCacheNow(usage.cache, false);',
        '  const cacheCold = rubatoCacheIsCold(usage.cache, cacheNow);',
        '  const ringColor = cacheCold ? "var(--color-error)" : usageColor;',
        '  const trackColor = cacheCold',
        '    ? "color-mix(in oklab, var(--color-error) 40%, transparent)"',
        '    : "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '        closeDelay={onCompact ? 150 : 0}',
      '        closeDelay={onCompact || usage.cache ? 150 : 0}',
      'replace',
    ],
    [
      '                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"',
      '                  stroke={trackColor}',
      'replace',
    ],
    [
      '                  stroke={usageColor}',
      '                  stroke={ringColor}',
      'replace',
    ],
    [
      [
        '          {usage.compactsAutomatically ? (',
        '            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">',
        '              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}',
        '            </div>',
        '          ) : null}',
      ].join('\n'),
      '          <RubatoCacheSection cache={usage.cache} environmentId={environmentId} />',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/ChatComposer.tsx': [
    [
      '  activeContextWindow: ContextWindowSnapshot | null;\n  reserveContextWindowMeter: boolean;\n',
      '  activeContextWindow: ContextWindowSnapshot | null;\n  reserveContextWindowMeter: boolean;\n  cacheEnvironmentId?: EnvironmentId | undefined;\n',
      'replace',
    ],
    [
      '          compactDisabledReason={props.compactDisabledReason}\n        />',
      '          compactDisabledReason={props.compactDisabledReason}\n          environmentId={props.cacheEnvironmentId}\n        />',
      'replace',
    ],
    [
      '                    reserveContextWindowMeter={reserveContextWindowMeter}\n',
      '                    reserveContextWindowMeter={reserveContextWindowMeter}\n                    cacheEnvironmentId={environmentId}\n',
      'replace',
    ],
  ],
  'apps/server/src/server.ts': [
    [
      'import { rubatoMemoryRouteLayer } from "./RubatoMemory.ts";\n',
      'import { rubatoMemoryRouteLayer } from "./RubatoMemory.ts";\nimport { rubatoCacheWarmingRouteLayer } from "./RubatoCacheWarming.ts";\n',
      'replace',
    ],
    [
      '    rubatoMemoryRouteLayer,\n',
      '    rubatoMemoryRouteLayer,\n    rubatoCacheWarmingRouteLayer,\n',
      'replace',
    ],
  ],
};
