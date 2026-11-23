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
  'packages/contracts/src/rubatoVoiceMark.test.ts',
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
  // A dictated message carries an invisible mark in front (RUBATO_VOICE_MARK); a call's or
  // Telegram's voice message carries "[voice] ". The model reads "[voice]" and interprets a misheard
  // word; a person sees the words with a light underline (user, 2026-11-24). One place says what the
  // mark is and how each side reads it, beside the model-facing sender note it joins.
  'packages/contracts/src/orchestrationV2.ts': [
    ['const LEADING_COMMAND = ',
      [
        '/**',
        ' * Rubato: the invisible mark the composers put in front of dictated text. It travels with the',
        ' * draft and the message on every path; withMessageSenderNote turns it into "[voice]" for the',
        ' * model, and the bubbles draw the message underlined instead (rubatoVoiceDisplay).',
        ' */',
        'export const RUBATO_VOICE_MARK = "\\u2063";',
        'const RUBATO_VOICE_TAG = /^\\[voice\\][ \\t]*/;',
        '',
        '/** A person\'s view of a message: without the mark or a leading "[voice]", and whether it was spoken. */',
        'export function rubatoVoiceDisplay(text: string): { readonly text: string; readonly voiced: boolean } {',
        '  if (text.startsWith(RUBATO_VOICE_MARK)) return { text: text.slice(RUBATO_VOICE_MARK.length), voiced: true };',
        '  const tag = RUBATO_VOICE_TAG.exec(text);',
        '  return tag ? { text: text.slice(tag[0].length), voiced: true } : { text, voiced: false };',
        '}',
        '',
        '/** The model\'s view: the mark reads as "[voice] ", so a misheard word is read as one. */',
        'export function rubatoVoiceForModel(text: string): string {',
        '  return text.startsWith(RUBATO_VOICE_MARK) ? "[voice] " + text.slice(RUBATO_VOICE_MARK.length) : text;',
        '}',
        '',
        '',
      ].join('\n')],
    ['  text: string,\n): string {\n  const agent = message.createdBy === "agent";',
      '  rawText: string,\n): string {\n  // Rubato: a dictated message reaches the model as "[voice] …".\n  const text = rubatoVoiceForModel(rawText);\n  const agent = message.createdBy === "agent";', 'replace'],
  ],
  // Every phone composer dictates through this hook; the Mac composer marks it in
  // useRubatoVoiceInput.ts. A GitHub issue comment is read by people, not a model, so it opts out.
  'apps/mobile/src/features/voice-input/useVoiceInputController.ts': [
    ['import { useGlobalVoiceInput } from "./VoiceInputProvider";\n',
      'import { withRubatoVoiceMark } from "@t3tools/shared/rubatoLiveDictation";\n'],
    ['  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;\n}) {\n',
      '  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;\n  /** Rubato: true where the text goes to people, not a model; no voice mark. */\n  readonly withoutVoiceMark?: boolean;\n}) {\n', 'replace'],
    ['        (text, selection) => {\n          captured.onChangeDraftMessage(text);\n',
      '        (committedText, committedSelection) => {\n          const { text, selection } = captured.withoutVoiceMark\n            ? { text: committedText, selection: committedSelection }\n            : withRubatoVoiceMark({ text: committedText, selection: committedSelection });\n          captured.onChangeDraftMessage(text);\n', 'replace'],
  ],
  'apps/mobile/src/features/issues/IssueCommentComposer.tsx': [
    ['    onChangeDraftMessage: changeDraft,\n    onChangeSelection: setSelection,\n  });\n',
      '    onChangeDraftMessage: changeDraft,\n    onChangeSelection: setSelection,\n    withoutVoiceMark: true,\n  });\n', 'replace'],
  ],
  // A title made from the first message is the person's words.
  'packages/client-runtime/src/operations/threadTitle.ts': [
    ['import { truncate } from "@t3tools/shared/String";\n',
      'import { rubatoVoiceDisplay } from "@t3tools/contracts";\n'],
    ['  const prose = replaceComposerContextReferences(value, (reference) => {\n',
      '  const prose = replaceComposerContextReferences(rubatoVoiceDisplay(value).text, (reference) => {\n', 'replace'],
  ],
  // The Mac thread's bubble: a spoken message is drawn underlined, without its mark.
  'apps/web/src/components/chat/TimelineUserMessageRow.tsx': [
    ['import ChatMarkdown from "../ChatMarkdown";\n',
      'import { rubatoVoiceDisplay } from "@t3tools/contracts";\n'],
    ['  if (props.text.length === 0) {\n    return null;\n  }\n  return (\n    <ChatMarkdown\n      text={props.text}',
      '  const voice = rubatoVoiceDisplay(props.text);\n  if (voice.text.length === 0) {\n    return null;\n  }\n  return (\n    <ChatMarkdown\n      text={voice.text}', 'replace'],
    ['      className="text-message-foreground user-message-markdown"\n',
      '      className={cn(\n        "text-message-foreground user-message-markdown",\n        voice.voiced && RUBATO_VOICE_UNDERLINE,\n      )}\n', 'replace'],
    ['const UserMessageBody = memo(function UserMessageBody(props: {',
      '/** Rubato: a spoken message, underlined lightly in its own ink. */\nconst RUBATO_VOICE_UNDERLINE =\n  "[text-decoration-line:underline] [text-decoration-color:color-mix(in_srgb,currentColor_35%,transparent)] [text-underline-offset:0.25em]";\n\n'],
  ],
  // The phone thread's bubble: a spoken message without links or chips is plain words, underlined.
  'apps/mobile/src/features/threads/ThreadFeed.tsx': [
    ['import type { ToolCallVisibility } from "@t3tools/contracts/settings";\n',
      'import { rubatoVoiceDisplay } from "@t3tools/contracts";\n'],
    ['    const renderedText = presentation.text;\n',
      '    const voice = isUser ? rubatoVoiceDisplay(presentation.text) : { text: presentation.text, voiced: false };\n    const renderedText = voice.text;\n', 'replace'],
    ['                        <UserMessageContent\n                          text={renderedText}\n',
      '                        {voice.voiced && !message.context?.records.length && !renderedText.includes("t3-context:") ? (\n                          <Text\n                            selectable\n                            style={{\n                              color: styles.nativeTextStyle.color,\n                              fontSize: styles.nativeTextStyle.fontSize,\n                              lineHeight: styles.nativeTextStyle.lineHeight,\n                              fontFamily: styles.nativeTextStyle.fontFamily,\n                              textDecorationLine: "underline",\n                              // The bubble\'s muted ink: a light line under spoken words.\n                              textDecorationColor: styles.nativeTextStyle.inlineCodeColor,\n                            }}\n                          >\n                            {renderedText}\n                          </Text>\n                        ) : (\n                        <UserMessageContent\n                          text={renderedText}\n', 'replace'],
    ['                          renderImage={props.renderMarkdownImage}\n                        />\n                      </CollapsibleUserMessageBody>',
      '                          renderImage={props.renderMarkdownImage}\n                        />\n                        )}\n                      </CollapsibleUserMessageBody>', 'replace'],
  ],
};
