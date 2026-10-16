// Voice hooks are kept together so unrelated T3 overlays retain their ownership.
export const voiceOverlays = [
  'apps/server/src/RubatoVoice.ts',
  'apps/web/src/state/rubatoVoice.ts',
  'apps/web/src/components/chat/useRubatoVoiceInput.ts',
  'apps/web/src/components/chat/RubatoVoiceControl.tsx',
];

// Dictation in the Mac composer: a microphone beside the attach control, and
// the shared voice controller wired to this composer's draft.
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
  '                  {isElectron ? (',
  '                    <RubatoVoiceControl',
  '                      state={voiceInput.state}',
  '                      elapsedSeconds={voiceInput.elapsedSeconds}',
  '                      onStart={voiceInput.start}',
  '                      onStop={voiceInput.stop}',
  '                      onCancel={voiceInput.cancel}',
  '                    />',
  '                  ) : null}',
  '                  {showComposerAttachAction ? (',
].join('\n');

// The composer anchors sit apart from apply.mjs's Speed label (it re-emits
// `{showComposerAttachAction ? (` after its label) and the other scripts' keys.
export const voiceEdits = {
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { Button } from "../ui/button";',
      'import { RubatoVoiceControl } from "./RubatoVoiceControl";\nimport { useRubatoVoiceInput } from "./useRubatoVoiceInput";\nimport { isElectron } from "../../env";\n'],
    ['  const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {', composerVoiceWiring],
    ['                  {showComposerAttachAction ? (', composerVoiceControl, 'replace'],
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
};
