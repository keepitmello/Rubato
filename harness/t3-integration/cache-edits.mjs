// The context ring shows the prompt cache. T3 v0.1.11 dropped the composer's context ring
// for a Context row in Thread details; Rubato keeps the ring (RubatoContextWindowMeter.tsx,
// T3 v0.1.0's ring with these additions): it turns red when the cache is cold, and its
// popover puts the cache facts and the thread's own warmer switch above the context window.
// The cache comes with the thread's Rubato state (GET /rubato/session-state, read by
// ChatView's useRubatoSessionState); ChatView hands the composer that and the same context
// snapshot Thread details reads. The switch posts to /rubato/cache-warming, which the bridge
// answers (bridge.mjs).
//
// The ring keeps v0.1.0's client setting, contextWindowMeterEnabled (off unless turned on),
// and its switch, Context window indicator, now on Settings › Labs: T3 v0.1.11 dropped both
// together with its legacy section in General.
export const cacheOverlays = [
  'apps/web/src/components/sidebar/RubatoCacheCapsule.tsx',
  'apps/web/src/components/sidebar/RubatoCacheCapsule.test.tsx',
  'apps/server/src/RubatoCacheWarming.ts',
  'apps/web/src/state/rubatoCacheWarming.ts',
  'apps/web/src/components/chat/RubatoCacheSection.tsx',
  'apps/web/src/components/chat/RubatoCacheSection.test.tsx',
  'apps/web/src/components/chat/RubatoContextWindowMeter.tsx',
];

export const cacheEdits = {
  // The ring sits left of the send button, where T3 v0.1.0 had it. Optimize context
  // (T3's manual compaction) shows when the thread's provider takes /compact.
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";\n',
      [
        'import { ContextWindowMeter, ContextWindowMeterPlaceholder } from "./RubatoContextWindowMeter";',
        'import type { ContextWindowSnapshot as RubatoContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";',
        'import type { RubatoCacheSnapshot } from "~/state/rubatoSessionState";',
        '',
      ].join('\n')],
    ['  compactThreadUnavailable: boolean;\n',
      [
        '  /** Rubato: the context ring (cache-edits.mjs). */',
        '  rubatoContextWindow?: RubatoContextWindowSnapshot | null;',
        '  rubatoCache?: RubatoCacheSnapshot | null;',
        '  rubatoReserveContextRing?: boolean;',
        '  rubatoCompactAvailable?: boolean;',
        '  rubatoCompactDisabledReason?: string | null;',
        '',
      ].join('\n')],
    ['    compactThreadUnavailable,\n    compactDisabled,\n',
      '    rubatoContextWindow,\n    rubatoCache,\n    rubatoReserveContextRing,\n    rubatoCompactAvailable,\n    rubatoCompactDisabledReason,\n'],
    ['                  <ComposerFooterPrimaryActions\n',
      [
        '                  {/* Rubato: the context ring with the prompt cache (cache-edits.mjs). */}',
        '                  {dictationTakesFooter || !settings.contextWindowMeterEnabled ? null : rubatoContextWindow ? (',
        '                    <ContextWindowMeter',
        '                      usage={rubatoContextWindow}',
        '                      onCompact={rubatoCompactAvailable ? compactThreadContextStable : undefined}',
        '                      compactDisabled={',
        '                        compactDisabled || noProviderAvailable || isSendBusy || phase === "connecting"',
        '                      }',
        '                      compactDisabledReason={',
        '                        rubatoCompactDisabledReason ??',
        '                        (noProviderAvailable ? "Compacting is unavailable right now" : null)',
        '                      }',
        '                      environmentId={environmentId}',
        '                      rubatoCache={rubatoCache}',
        '                    />',
        '                  ) : rubatoReserveContextRing && settings.contextWindowMeterEnabled ? (',
        '                    <ContextWindowMeterPlaceholder />',
        '                  ) : null}',
        '',
      ].join('\n')],
  ],
  'packages/contracts/src/settings.ts': [
    ['  boringSidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),\n',
      '  // Rubato: the composer\'s context ring, off unless turned on (cache-edits.mjs).\n  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),\n'],
    ['  boringSidebarEnabled: Schema.optionalKey(Schema.Boolean),\n',
      '  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),\n'],
  ],
  'apps/web/src/components/settings/LabsSettingsPanel.tsx': [
    ['        <BoringSidebarRow />\n', '        <RubatoContextRingRow />\n'],
    ['function BoringSidebarRow() {\n',
      [
        '/** Rubato: the composer\'s context ring with the prompt cache (cache-edits.mjs). */',
        'function RubatoContextRingRow() {',
        '  const searchableSetting = useSearchableSetting();',
        '  const settings = useScopedSettings();',
        '  const updateSettings = useUpdateScopedSettings();',
        '  const gt = useGT();',
        '  return (',
        '    <SettingsRow',
        '      {...searchableSetting("legacy-context-window-indicator")}',
        '      description={gt("Shows context window usage as a circular indicator in the composer.")}',
        '      control={',
        '        <Switch',
        '          checked={settings.contextWindowMeterEnabled}',
        '          onCheckedChange={(checked) =>',
        '            updateSettings({ contextWindowMeterEnabled: Boolean(checked) })',
        '          }',
        '          aria-label={gt("Context window indicator (legacy)")}',
        '        />',
        '      }',
        '    />',
        '  );',
        '}',
        '',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  {\n    id: "boring-sidebar",\n',
      [
        '  {',
        '    id: "legacy-context-window-indicator",',
        '    title: msg("Context window indicator (legacy)"),',
        '    to: "/settings/labs",',
        '    searchTerms: [msg("composer meter usage tokens circle old ring prompt cache 컨텍스트 링 캐시")],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['  const compactDisabled = compactThreadUnavailable;\n',
      [
        '  const rubatoCompactDisabledReason = compactThreadUnavailable',
        '    ? !canOperateThread',
        '      ? "This connection cannot change threads."',
        '      : !activeProject',
        '        ? "Choose a project before compacting"',
        '        : !manualCompactionProviderAvailable',
        '          ? "Compaction is unavailable for this provider"',
        '          : "Compacting is unavailable right now"',
        '    : null;',
        '',
      ].join('\n')],
    ['                                compactThreadUnavailable={compactThreadUnavailable}\n',
      [
        '                                rubatoContextWindow={activeContextWindow}',
        '                                rubatoCache={rubatoSessionState.cache}',
        '                                rubatoReserveContextRing={threadDetailLoading && isServerThread}',
        '                                rubatoCompactAvailable={manualCompactionProviderAvailable}',
        '                                rubatoCompactDisabledReason={rubatoCompactDisabledReason}',
        '',
      ].join('\n')],
  ],
  // The new sidebar has no capsule; its thread hover card carries one cache line under
  // the model row instead: until when the warmer holds the cache, how long it lasts on its
  // own, or that it has expired (RubatoCacheHoverRow).
  'apps/web/src/components/sidebar/SidebarThreadRow.tsx': [
    [
      'import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";\n',
      'import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";\nimport { RubatoCacheHoverRow } from "./RubatoCacheCapsule";\n',
      'replace',
    ],
    [
      '        {previousProviderNames.length > 0 ? (\n',
      '        <RubatoCacheHoverRow environmentId={thread.environmentId} threadId={thread.id} />\n',
    ],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoCacheWarmingRouteLayer } from "./RubatoCacheWarming.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoCacheWarmingRouteLayer,\n'],
  ],
};
