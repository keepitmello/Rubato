// Opening a new conversation on another system prompt (RubatoSessionPrompt.tsx). This adds:
//
// - under the new-thread headline, a "시스템 프롬프트" chip whose menu lists Rubato's own
//   prompt, the files in ~/.rubato/prompts and ~/Documents/SOUL.md, text written for this
//   conversation only, another file, and the folder itself. It shows only for a Rubato model;
//
// - just before a draft's first message, /rubato/session-prompts/prepare
//   (RubatoSessionPrompt.ts) hands the chosen text to the bridge, and the session that message
//   opens is created with it as its whole system prompt. A failure stops the send;
//
// - in a started thread's header, a badge naming the prompt it runs on.
export const sessionPromptOverlays = [
  'apps/server/src/RubatoSessionPrompt.ts',
  'apps/web/src/components/chat/RubatoSessionPrompt.tsx',
];

export const sessionPromptEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";',
      'import { rubatoSessionPromptRouteLayer } from "./RubatoSessionPrompt.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoSessionPromptRouteLayer,\n'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";\n',
      'import { prepareRubatoSessionPrompt, RubatoSessionPromptChip } from "./chat/RubatoSessionPrompt";\n'],
    [[
      '                          activeProjectTitle={activeProject?.title ?? null}',
      '                        />',
      '',
    ].join('\n'), [
      '                          activeProjectTitle={activeProject?.title ?? null}',
      '                        />',
      '                        <RubatoSessionPromptChip',
      '                          environmentId={activeThread.environmentId}',
      '                          draftKey={draftId}',
      '                          instanceId={activeProviderInstanceId}',
      '                        />',
      '',
    ].join('\n'), 'replace'],
    ['    let turnStartSucceeded = false;\n', [
      '    // A Rubato draft opened on another system prompt hands it over before the session exists.',
      '    if (failure === null && isLocalDraftThread) {',
      '      const sessionPromptResult = await settlePromise(() =>',
      '        prepareRubatoSessionPrompt({',
      '          environmentId,',
      '          draftKey: draftId,',
      '          threadId: threadIdForSend,',
      '          instanceId: threadCreateModelSelection.instanceId,',
      '        }),',
      '      );',
      '      if (sessionPromptResult._tag === "Failure") {',
      '        failure = sessionPromptResult;',
      '      }',
      '    }',
      '',
    ].join('\n')],
  ],
  'apps/web/src/components/chat/ChatHeader.tsx': [
    ['import { Button } from "../ui/button";\n',
      'import { RubatoSessionPromptBadge } from "./RubatoSessionPrompt";\n'],
    ['        </WorkspaceBreadcrumbItem>\n      </WorkspaceBreadcrumb>\n', [
      '          {isServerThread ? (',
      '            <RubatoSessionPromptBadge',
      '              environmentId={activeThreadEnvironmentId}',
      '              threadId={activeThreadId}',
      '            />',
      '          ) : null}',
      '',
    ].join('\n')],
  ],
};
