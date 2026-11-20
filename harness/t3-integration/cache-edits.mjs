// The prompt cache in Thread details. The cache comes with the thread's Rubato state
// (GET /rubato/session-state, read by ChatView's useRubatoSessionState) and goes to the
// Thread details panel with the context window; the panel shows the cache facts and the
// thread's own warmer switch above the context row. The switch posts to
// /rubato/cache-warming, which the bridge answers (bridge.mjs).
export const cacheOverlays = [
  'apps/web/src/components/sidebar/RubatoCacheCapsule.tsx',
  'apps/web/src/components/sidebar/RubatoCacheCapsule.test.tsx',
  'apps/server/src/RubatoCacheWarming.ts',
  'apps/web/src/state/rubatoCacheWarming.ts',
  'apps/web/src/components/chat/RubatoCacheSection.tsx',
  'apps/web/src/components/chat/RubatoCacheSection.test.tsx',
];

export const cacheEdits = {
  // The prompt cache sits in Thread details, above the context window row: the cache facts
  // and the thread's own warmer switch (RubatoCacheSection). The cache reaches the panel
  // through ChatView's usage input, beside the context window it describes.
  'apps/web/src/components/chat/ThreadDetailsUsage.tsx': [
    ['import { formatContextWindowCompactionMessage } from "./compaction.logic";\n',
      'import type { RubatoCacheSnapshot } from "~/state/rubatoSessionState";\n'],
    ['  readonly contextWindow: ContextWindowSnapshot | null;\n}\n',
      '  readonly contextWindow: ContextWindowSnapshot | null;\n  /** Rubato: the thread\'s prompt cache (cache-edits.mjs). */\n  readonly rubatoCache?: RubatoCacheSnapshot | null | undefined;\n}\n',
      'replace'],
  ],
  'apps/web/src/components/chat/ThreadDetailsPanel.tsx': [
    ['import { ThreadDetailsSection } from "./ThreadDetailsSection";\n',
      'import { RubatoCacheSection } from "./RubatoCacheSection";\n'],
    ['              {visible.context && props.usage.contextWindow ? (\n',
      [
        '              {/* Rubato: the prompt cache, above the context it keeps warm (cache-edits.mjs). */}',
        '              {visible.context && props.usage.rubatoCache ? (',
        '                <ThreadDetailsSection',
        '                  headingId="thread-details-cache-heading"',
        '                  title="Prompt cache"',
        '                  showHeading={false}',
        '                >',
        '                  <RubatoCacheSection',
        '                    cache={props.usage.rubatoCache}',
        '                    environmentId={props.environmentId}',
        '                  />',
        '                </ThreadDetailsSection>',
        '              ) : null}',
        '',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['                    contextWindow: activeContextWindow,\n                  }}\n',
      '                    contextWindow: activeContextWindow,\n                    rubatoCache: rubatoSessionState.cache,\n                  }}\n',
      'replace'],
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
