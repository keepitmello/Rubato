// Voice hooks are kept together so unrelated T3 overlays retain their ownership.
export const voiceOverlays = [
  'apps/server/src/RubatoVoice.ts',
  'apps/web/src/state/rubatoVoice.ts',
  'apps/web/src/state/rubatoVoice.test.ts',
  'apps/web/src/components/chat/useRubatoVoiceInput.ts',
  'apps/web/src/components/chat/RubatoVoiceControl.tsx',
  'apps/web/src/state/rubatoVoiceSettings.ts',
  'apps/web/src/components/settings/RubatoVoiceSettings.tsx',
  'apps/web/src/components/chat/RubatoLiveDictationText.tsx',
  'apps/web/src/components/chat/RubatoVoiceControl.css',
  'packages/shared/src/rubatoLiveDictation.ts',
  'packages/shared/src/rubatoLiveDictation.test.ts',
];

// Dictation in the Mac composer: a microphone beside the attach control, and
// the shared voice controller wired to this composer's draft. It is live: the
// words heard so far stand in the editor's place while the microphone is open
// (RubatoLiveDictationText), and the final text goes into the draft at stop.
const composerVoiceWiring = [
  '  const voiceInput = useRubatoVoiceInput({',
  '    ownerKey: composerDraftTargetKey,',
  '    environmentId,',
  '    readDraft: () => {',
  '      const snapshot = readComposerSnapshot();',
  '      const range = composerEditorRef.current?.readSelectionRange();',
  '      return {',
  '        text: snapshot.value,',
  '        start: range?.start ?? snapshot.expandedCursor,',
  '        end: range?.end ?? snapshot.expandedCursor,',
  '      };',
  '    },',
  '    draftText: prompt,',
  '    commitDraft: (text, cursor) => {',
  '      const nextCursor = collapseExpandedComposerCursor(text, cursor);',
  '      promptRef.current = text;',
  '      setPrompt(text);',
  '      setComposerCursor(nextCursor);',
  '      setComposerTrigger(null);',
  '      window.requestAnimationFrame(() => composerEditorRef.current?.focusAt(nextCursor));',
  '    },',
  '  });',
  '',
  '',
].join('\n');

const composerVoiceControl = [
  '                {isElectron ? (',
  '                  <RubatoVoiceControl',
  '                    state={voiceInput.state}',
  '                    stage={voiceInput.stage}',
  '                    readLevel={voiceInput.readLevel}',
  '                    onStart={voiceInput.start}',
  '                    onStop={voiceInput.stop}',
  '                    onCancel={voiceInput.cancel}',
  '                  />',
  '                ) : null}',
  '                {composerAttachButton && !dictationTakesFooter ? (',
].join('\n');

// The mic sits left of the attach control, which v0.1.11 builds into a variable and
// renders ahead of the action row. call-edits.mjs anchors on the same line, so a later
// edit that re-emits it would duplicate the anchor.
export const voiceEdits = {
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { Button } from "../ui/button";',
      'import { RubatoVoiceControl } from "./RubatoVoiceControl";\nimport { RubatoLiveDictationText } from "./RubatoLiveDictationText";\nimport { useRubatoVoiceInput } from "./useRubatoVoiceInput";\nimport { isElectron } from "../../env";\n'],
    ['  const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {', composerVoiceWiring],
    ['                {composerAttachButton && !dictationTakesFooter ? (', composerVoiceControl, 'replace'],
    // The Mac app keeps one microphone, Rubato's: T3's own dictation button, its recording
    // capsule and its shortcut stay off there. A browser without the Mac app keeps T3's.
    ['    speech: speechInput,\n    disabled: dictationDisabled,\n',
      '    speech: speechInput,\n    disabled: dictationDisabled || isElectron,\n', 'replace'],
    ['                    {speechInput.available ? (\n',
      '                    {speechInput.available && !isElectron ? (\n', 'replace'],
    ['                <ComposerContextActionsContext value={composerContextActions}>\n                  <ComposerPromptEditor\n',
      [
        '                {voiceInput.showsLive ? (',
        '                  <RubatoLiveDictationText',
        '                    draft={voiceInput.liveDraft ?? { text: prompt, start: prompt.length, end: prompt.length }}',
        '                    connecting={voiceInput.state.phase === "preparing"}',
        '                    settling={voiceInput.stage === "settling"}',
        '                    committed={prompt}',
        '                  />',
        '                ) : null}',
        '',
      ].join('\n')],
    ['                    className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}\n',
      '                    containerClassName={cn(voiceInput.showsLive && "hidden")}\n'],
  ],
  // The live dictation module is shared with the phone (@t3tools/shared/rubatoLiveDictation).
  'packages/shared/package.json': [
    ['    "./composerTrigger": {\n',
      '    "./rubatoLiveDictation": {\n      "types": "./src/rubatoLiveDictation.ts",\n      "import": "./src/rubatoLiveDictation.ts"\n    },\n'],
  ],
  // Settings › Voice › Voice input (settings/RubatoVoiceSettings.tsx), found by search.
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  {\n    id: "project-grouping",\n',
      [
        '  {',
        '    id: "rubato-voice",',
        '    title: "Voice input",',
        '    to: "/settings/voice",',
        '    searchTerms: ["voice dictation microphone speech to text stt transcription openai api key whisper shortcut 음성 입력 받아쓰기 마이크 전사 키"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoVoiceRouteLayer } from "./RubatoVoice.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoVoiceRouteLayer,\n'],
  ],
  // Presence: which thread a phone has open (its V2 thread subscription) and
  // whether it is in the foreground (its activity report).
  'apps/server/src/ws.ts': [
    ['import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";', 'import { noteVoiceActivity, noteVoiceSubscription } from "./RubatoVoice.ts";\n'],
    ['        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>\n          Stream.unwrap(\n            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(\n',
      '        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input, metadata) =>\n          Stream.unwrap(\n            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(\n              Effect.andThen(noteVoiceSubscription({ sessionId: currentSessionId, rpcClientId: metadata.client.id, threadId: input.threadId })),\n', 'replace'],
    ['        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>\n          Ref.update(rpcClientIds, (clientIds) => {',
      '        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>\n          Ref.update(rpcClientIds, (clientIds) => {\n            noteVoiceActivity({ ...input, sessionId: currentSessionId, rpcClientId: metadata.client.id });', 'replace'],
  ],
  // Dictated text goes into the draft behind a "[voice]" mark, once, so the model reads past a
  // misheard word. Every phone composer dictates through this hook; the Mac composer tags it in
  // useRubatoVoiceInput.ts. A GitHub issue comment is read by people, not a model, so it opts out.
  'apps/mobile/src/features/voice-input/useVoiceInputController.ts': [
    ['import { useGlobalVoiceInput } from "./VoiceInputProvider";\n',
      'import { withRubatoVoiceTag } from "@t3tools/shared/rubatoLiveDictation";\n'],
    ['  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;\n}) {\n',
      '  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;\n  /** Rubato: true where the text goes to people, not a model; no "[voice]" mark. */\n  readonly withoutVoiceTag?: boolean;\n}) {\n', 'replace'],
    ['        (text, selection) => {\n          captured.onChangeDraftMessage(text);\n',
      '        (committedText, committedSelection) => {\n          const { text, selection } = captured.withoutVoiceTag\n            ? { text: committedText, selection: committedSelection }\n            : withRubatoVoiceTag({ text: committedText, selection: committedSelection });\n          captured.onChangeDraftMessage(text);\n', 'replace'],
  ],
  'apps/mobile/src/features/issues/IssueCommentComposer.tsx': [
    ['    onChangeDraftMessage: changeDraft,\n    onChangeSelection: setSelection,\n  });\n',
      '    onChangeDraftMessage: changeDraft,\n    onChangeSelection: setSelection,\n    withoutVoiceTag: true,\n  });\n', 'replace'],
  ],
  // The mark is for the model; a title made from the first message leaves it out.
  'packages/client-runtime/src/operations/threadTitle.ts': [
    ['import { truncate } from "@t3tools/shared/String";\n',
      'import { withoutRubatoVoiceTag } from "@t3tools/shared/rubatoLiveDictation";\n'],
    ['  const prose = replaceComposerContextReferences(value, (reference) => {\n',
      '  const prose = replaceComposerContextReferences(withoutRubatoVoiceTag(value), (reference) => {\n', 'replace'],
  ],
};
