// Opening a new conversation on another system prompt (RubatoSessionPrompt.tsx). This adds:
//
// - `/prompt` in the composer's slash menu of a Rubato draft. It opens a menu above the input
//   that lists Rubato's own prompt, the files in ~/.rubato/prompts and ~/Documents/SOUL.md, text
//   written for this conversation only, another file, and the folder itself. Rubato's own prompt
//   shows nothing on screen; another prompt, including the last file chosen that a new draft
//   starts on, stays as a chip above the input until the first message;
//
// - just before a draft's first message, /rubato/session-prompts/prepare
//   (RubatoSessionPrompt.ts) hands the chosen text to the bridge, and the session that message
//   opens is created with it as its whole system prompt. A failure stops the send;
//
// - in a started thread's header, a badge naming the prompt it runs on.
export const sessionPromptOverlays = [
  'apps/server/src/RubatoSessionPrompt.ts',
  'apps/web/src/components/chat/RubatoSessionPrompt.tsx',
  'apps/web/src/components/chat/RubatoSessionPrompt.test.tsx',
];

export const sessionPromptEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";',
      'import { rubatoSessionPromptRouteLayer } from "./RubatoSessionPrompt.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoSessionPromptRouteLayer,\n'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";\n',
      'import { prepareRubatoSessionPrompt } from "./chat/RubatoSessionPrompt";\n'],
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
  // `/prompt` is a built-in like /model: chosen in the menu, it never reaches the agent.
  'apps/web/src/composer-logic.ts': [
    ['export type ComposerSlashCommand = "model" | "plan" | "default";',
      'export type ComposerSlashCommand = "model" | "plan" | "default" | "prompt";', 'replace'],
    ['): Exclude<ComposerSlashCommand, "model"> | null {',
      '): Exclude<ComposerSlashCommand, "model" | "prompt"> | null {', 'replace'],
  ],
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { ComposerImageThumbnail } from "./ComposerImageThumbnail";\n', [
      'import {',
      '  openRubatoSessionPromptMenu,',
      '  rubatoSessionPromptAvailable,',
      '  RubatoSessionPromptPicker,',
      '} from "./RubatoSessionPrompt";',
      '',
    ].join('\n')],
    ['      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;\n', [
      '        ...(rubatoSessionPromptAvailable(environmentId, draftId, selectedProviderEntry?.instanceId ?? null)',
      '          ? ([',
      '              {',
      '                id: "slash:prompt",',
      '                type: "slash-command",',
      '                command: "prompt",',
      '                label: "/prompt",',
      '                description: "이 대화를 다른 시스템 프롬프트로 열기",',
      '              },',
      '            ] as const)',
      '          : []),',
      '',
    ].join('\n')],
    ['    compactSlashCommandAvailable,\n    composerTrigger,\n    exactPullRequestLookup.data,\n',
      '    draftId,\n    environmentId,\n    selectedProviderEntry,\n'],
    ['        if (!planModeUiEnabled) return;\n        void handleInteractionModeChange(', [
      '        if (item.command === "prompt") {',
      '          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {',
      '            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),',
      '            focusEditorAfterReplace: false,',
      '          });',
      '          if (applied) {',
      '            setComposerHighlightedItemId(null);',
      '            openRubatoSessionPromptMenu(draftId);',
      '          }',
      '          return;',
      '        }',
      '',
    ].join('\n')],
    ['      planModeUiEnabled,\n      onUsageLimitsCommand,\n      resolveActiveComposerTrigger,\n    ],\n',
      '      draftId,\n'],
    [[
      '              {!isComposerCollapsedMobile &&',
      '                !isComposerApprovalState &&',
      '                (uncommittedSnapShotIds.length > 0 ||',
    ].join('\n'), [
      '              {!isComposerCollapsedMobile && !isComposerApprovalState ? (',
      '                <RubatoSessionPromptPicker',
      '                  environmentId={environmentId}',
      '                  draftKey={draftId}',
      '                  instanceId={selectedProviderEntry?.instanceId ?? null}',
      '                  onReturnFocus={() => composerEditorRef.current?.focusAtEnd()}',
      '                />',
      '              ) : null}',
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
