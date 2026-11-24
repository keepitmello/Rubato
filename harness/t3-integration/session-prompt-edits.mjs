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
  'apps/server/src/provider/agyPrompt.mjs',
  'apps/server/src/provider/agyPrompt.d.mts',
  'apps/server/src/provider/session-prompts.mjs',
  'apps/server/src/provider/session-prompts.d.mts',
  'apps/server/src/RubatoSessionPrompt.ts',
  'apps/web/src/components/chat/RubatoSessionPrompt.tsx',
  'apps/web/src/components/chat/RubatoSessionPrompt.test.tsx',
];

export const sessionPromptEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";',
      'import { rubatoSessionPromptRouteLayer } from "./RubatoSessionPrompt.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoSessionPromptRouteLayer,\n'],
  ],
  // The send path moved out of ChatView into useComposerSend.ts.
  'apps/web/src/components/chat/useComposerSend.ts': [
    ['import { armFreshSession, disarmFreshSession, readFreshSessionArm } from "./freshSessionArms";\n',
      'import { prepareRubatoSessionPrompt } from "./RubatoSessionPrompt";\n'],
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
    ['export type ComposerSlashCommand = "model" | "side" | "btw" | "clear";',
      'export type ComposerSlashCommand = "model" | "side" | "btw" | "clear" | "prompt";', 'replace'],
  ],
  // The slash menu moved out of ChatComposer into this hook, which takes its inputs as params.
  'apps/web/src/components/chat/useComposerMenuItems.ts': [
    ['import {\n  searchSlashCommandItems,\n  slashCommandItemsForPromptPosition,\n} from "./composerSlashCommandSearch";\n',
      'import { rubatoSessionPromptAvailable } from "./RubatoSessionPrompt";\n'],
    ['  readonly modelMentions: {\n',
      '  readonly draftId: DraftId | null;\n  readonly selectedProviderInstanceId: ProviderInstanceId | null;\n'],
    ['  modelMentions,\n}: {\n',
      '  draftId,\n  selectedProviderInstanceId,\n'],
    ['      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;\n', [
      '        ...(rubatoSessionPromptAvailable(environmentId, draftId, selectedProviderInstanceId)',
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
  ],
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { copySnapshot } from "./copySnapshot";\n',
      'import { openRubatoSessionPromptMenu, RubatoSessionPromptPicker } from "./RubatoSessionPrompt";\n'],
    ['    modelMentions: { instanceEntries: providerInstanceEntries, modelOptionsByInstance },\n', [
      '    modelMentions: { instanceEntries: providerInstanceEntries, modelOptionsByInstance },',
      '    draftId,',
      '    selectedProviderInstanceId: selectedProviderEntry?.instanceId ?? null,',
      '',
    ].join('\n'),
      'replace'],
    ['      if (item.command === "clear") {\n', [
      '      if (item.command === "prompt") {',
      '        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {',
      '          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),',
      '          focusEditorAfterReplace: false,',
      '        });',
      '        if (applied) {',
      '          setComposerHighlightedItemId(null);',
      '          openRubatoSessionPromptMenu(draftId);',
      '        }',
      '        return;',
      '      }',
      '',
    ].join('\n')],
    ['              {composerAttachmentMediaRow}\n', [
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
    ['import { cn } from "~/lib/utils";\n',
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
