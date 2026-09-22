// Voice hooks are kept together so unrelated T3 overlays retain their ownership.
export const voiceOverlays = [
  'apps/server/src/RubatoVoice.ts',
  'apps/web/src/state/rubatoVoice.ts',
  'apps/web/src/components/chat/useRubatoVoiceInput.ts',
  'apps/web/src/components/chat/RubatoVoiceControl.tsx',
  'apps/server/src/orchestration/Layers/RubatoVoiceTurnGuard.test.ts',
];

// Dictation in the Mac composer: a microphone beside the attach control, and
// the shared voice controller wired to this composer's draft.
const composerVoiceWiring = [
  '  const voiceInput = useRubatoVoiceInput({',
  '    ownerKey: composerTargetKey(composerDraftTarget),',
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
  '      promptRef.current = text;',
  '      setPrompt(text);',
  '      setComposerCursor(collapseExpandedComposerCursor(text, cursor));',
  '      window.requestAnimationFrame(() => composerEditorRef.current?.focus());',
  '    },',
  '  });',
  '',
  '  const insertComposerTextAtEnd = useCallback<ChatComposerHandle["insertTextAtEnd"]>(',
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

export const voiceEdits = {
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { Button } from "../ui/button";',
      'import { RubatoVoiceControl } from "./RubatoVoiceControl";\nimport { useRubatoVoiceInput } from "./useRubatoVoiceInput";\nimport { isElectron } from "../../env";\n'],
    ['  const insertComposerTextAtEnd = useCallback<ChatComposerHandle["insertTextAtEnd"]>(', composerVoiceWiring, 'replace'],
    ['                  {showComposerAttachAction ? (', composerVoiceControl, 'replace'],
  ],
  'apps/server/src/server.ts': [
    ['import * as NodeHttp from "node:http";', 'import { rubatoVoiceRouteLayer } from "./RubatoVoice.ts";\n'],
    ['    attachmentUploadRouteLayer,\n', '    rubatoVoiceRouteLayer,\n'],
  ],
  'apps/server/src/ws.ts': [
    ['import {\n  sameUsageLimitCommandCoverage,', 'import { noteVoiceActivity, noteVoiceSubscription } from "./RubatoVoice.ts";\n'],
    ['[ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>',
      '[ORCHESTRATION_WS_METHODS.subscribeThread]: (input, metadata) =>', 'replace'],
    ['              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>',
      '              const releaseVoice = noteVoiceSubscription({ sessionId: currentSessionId, rpcClientId: metadata.client.id, threadId: input.threadId });\n              yield* Effect.addFinalizer(() => Effect.sync(releaseVoice));\n'],
    ['        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>\n          Ref.update(rpcClientIds, (clientIds) => {',
      '        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>\n          Ref.update(rpcClientIds, (clientIds) => {\n            noteVoiceActivity({ ...input, sessionId: currentSessionId, rpcClientId: metadata.client.id });', 'replace'],
  ],
  'packages/contracts/src/orchestration.ts': [
    ['export const ThreadTurnStartCommand = Schema.Struct({\n  type: Schema.Literal("thread.turn.start"),',
      'export const ThreadTurnStartCommand = Schema.Struct({\n  type: Schema.Literal("thread.turn.start"),\n  onlyWhenIdle: Schema.optional(Schema.Boolean),', 'replace'],
  ],
  'apps/server/src/orchestration/Layers/OrchestrationEngine.ts': [
    ['import { decideOrchestrationCommand } from "../decider.ts";',
      'import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";\nimport { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";\n'],
    ['  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;',
      '  const voiceTurnRepository = yield* ProjectionTurnRepository;\n'],
    ['        if (\n          envelope.command.type === "thread.auto-settle" &&\n          (yield* eventStore.hasEventAfter({',
      '        if (envelope.command.type === "thread.turn.start" && envelope.command.onlyWhenIdle) {\n          const voiceThreadId = envelope.command.threadId;\n          const thread = commandReadModel.threads.find((entry) => entry.id === voiceThreadId);\n          const pending = yield* voiceTurnRepository.getPendingTurnStartByThreadId({ threadId: voiceThreadId });\n          if (Option.isSome(pending) || thread?.session?.status === "running" || thread?.session?.status === "starting" || thread?.latestTurn?.state === "running") {\n            return yield* new OrchestrationCommandInvariantError({ commandType: envelope.command.type, detail: "RUBATO_VOICE_THREAD_BUSY" });\n          }\n        }\n\n'],
    ['            if (isOrchestrationCommandRejection(error)) {',
      '            const voiceBusy = envelope.command.type === "thread.turn.start" && envelope.command.onlyWhenIdle &&\n              "detail" in error && error.detail === "RUBATO_VOICE_THREAD_BUSY";\n            if (isOrchestrationCommandRejection(error) && !voiceBusy) {', 'replace'],
    ['  makeOrchestrationEngine,\n);', '  makeOrchestrationEngine,\n).pipe(Layer.provide(ProjectionTurnRepositoryLive));', 'replace'],
  ],
};
