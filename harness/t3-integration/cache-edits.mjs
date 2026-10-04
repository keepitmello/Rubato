// The context ring shows the prompt cache. The bridge adds `cache` to the usage snapshot
// (events.mjs cacheFrom); these edits let it through the contract and the web reader,
// turn the ring red when the cache is cold, and put the cache facts and the thread's own
// warmer switch in the ring's popover where the auto-compaction note used to be. The
// switch posts to /rubato/cache-warming, which the bridge answers (bridge.mjs).
export const cacheOverlays = [
  'apps/web/src/components/sidebar/RubatoCacheCapsule.tsx',
  'apps/web/src/components/sidebar/RubatoCacheCapsule.test.tsx',
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
        '    from: Schema.optional(NonNegativeInt),',
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
      '                  className="stroke-muted-foreground/24"',
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
        '            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">',
        '              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}',
        '            </div>',
        '          ) : null}',
      ].join('\n'),
      '          {/* Rubato: the prompt cache sits above the context (RubatoCacheSection). */}',
      'replace',
    ],
    // Cache on top, context and its optimization below, so the two layers do not mix.
    [
      '        <div className="flex flex-col gap-2 p-(--floating-content-inset)">\n',
      '        <div className="flex flex-col gap-2 p-(--floating-content-inset)">\n          <RubatoCacheSection cache={usage.cache} environmentId={environmentId} />\n',
      'replace',
    ],
    [
      '                <Minimize2Icon aria-hidden="true" />\n                Compact context',
      '                <Minimize2Icon aria-hidden="true" />\n                Optimize context',
      'replace',
    ],
    // The popover borrows the tooltip surface, where T3's muted greys sit close to the
    // background and read as blurred. Headings and figures take the popover's own text
    // colour and labels a softened one; RubatoCacheSection follows the same two tones.
    [
      '<div className="font-medium text-muted-foreground text-xs">Context Window</div>',
      '<div className="font-medium text-popover-foreground text-xs">Context Window</div>',
      'replace',
    ],
    [
      '              <div className="text-secondary-label text-2xs tabular-nums">\n                <span>{usedPercentage}</span>',
      '              <div className="text-popover-foreground text-2xs tabular-nums">\n                <span>{usedPercentage}</span>',
      'replace',
    ],
    [
      '              <div className="text-secondary-label text-2xs tabular-nums">\n                {formatContextWindowTokens(usage.usedTokens)}',
      '              <div className="text-popover-foreground text-2xs tabular-nums">\n                {formatContextWindowTokens(usage.usedTokens)}',
      'replace',
    ],
    [
      '              <span className="text-secondary-label">Total processed</span>\n              <span className="font-medium tabular-nums text-secondary-label">',
      '              <span className="text-popover-foreground/65">Total processed</span>\n              <span className="font-medium tabular-nums text-popover-foreground">',
      'replace',
    ],
    [
      '                <div className="text-pretty text-secondary-label text-2xs">\n                  {compactDisabledReason}',
      '                <div className="text-pretty text-popover-foreground/65 text-2xs">\n                  {compactDisabledReason}',
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
  // The sidebar row shows a thin capsule above its time label while the thread's prompt
  // cache is warm: what is left of the cache's life, orange while the warmer holds it.
  // A line, not a ring, so it does not echo the status dot at the row's other end. The
  // meta area fades to the archive button on hover, so the capsule only shows and the
  // numbers (cache first, then the warmer) join the title's tooltip.
  //
  // The meta slot is a column, capsule first: centred while the cache is cold, and
  // bottom-aligned while the capsule is there — the pair then hangs from the row's
  // bottom, which is what puts the 3px capsule on the row's own centre with the time
  // under it. `has` keys that on the capsule's own data attribute, so nothing else has
  // to know whether the cache is warm.
  'apps/web/src/components/LegacySidebar.tsx': [
    [
      '            <span className={threadMetaClassName}>\n              <span className="inline-flex items-center gap-1">\n',
      [
        '            <span',
        '              className={cn(',
        '                threadMetaClassName,',
        '                "flex flex-col items-center justify-center self-stretch [&:has(>[data-rubato-cache])]:justify-end",',
        '              )}',
        '            >',
        '              <RubatoCacheCapsule environmentId={thread.environmentId} threadId={thread.id} />',
        '              <span className="inline-flex items-center gap-1">',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '              <TooltipPopup side="top">{thread.title}</TooltipPopup>\n',
      '              <TooltipPopup side="top">\n                {thread.title}\n                <RubatoCacheTooltip environmentId={thread.environmentId} threadId={thread.id} />\n              </TooltipPopup>\n',
      'replace',
    ],
    [
      '} from "./ThreadStatusIndicators";\n',
      '} from "./ThreadStatusIndicators";\nimport { RubatoCacheCapsule, RubatoCacheTooltip } from "./sidebar/RubatoCacheCapsule";\n',
      'replace',
    ],
  ],
  // The compact button reads "Optimize context"; T3's own test names the button.
  'apps/web/src/components/chat/ContextWindowMeter.test.tsx': [
    ['    expect(markup).toContain("Compact context");', '    expect(markup).toContain("Optimize context");', 'replace'],
    ['    expect(markup).not.toContain("Compact context");', '    expect(markup).not.toContain("Optimize context");', 'replace'],
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
