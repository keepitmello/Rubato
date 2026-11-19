// Editing a sent message from a long press on its bubble, which rewinds the conversation to just
// before it and sends the edit in its place (user 1987aa80), in a thread here and in a companion's
// room in CompanionRoomScreen.tsx. The edit itself lives in features/rubato-message-edit: the
// composer state asks it to rewind before a send, the feed wraps the person's bubble in its
// long-press menu, and the thread screen shows its banner over the composer.
//
// A thread's bubble keeps T3's selectable text; the menu sits around the whole row so the bubble's
// widths (a share of the row) stay as T3 set them.
export const mobileMessageEditOverlays = [
  'apps/mobile/src/features/rubato-message-edit/sentMessageEdit.ts',
  'apps/mobile/src/features/rubato-message-edit/SentMessageMenu.tsx',
  'apps/mobile/src/features/rubato-message-edit/sentMessageEdit.test.ts',
];

export const mobileMessageEditEdits = {
  'apps/mobile/src/state/use-thread-composer-state.ts': [
    ['import { enqueueThreadOutboxMessage } from "./thread-outbox";\n',
      'import { rewindBeforeSend } from "../features/rubato-message-edit/sentMessageEdit";\n'],
    ['      const contextBlockReason = composerContextSendBlockReason(draft.context);\n',
      '      // Rubato: a sent message under edit rewinds the conversation to just before it first\n'
        + '      // (features/rubato-message-edit). If it cannot now, the edit stays in the composer.\n'
        + '      try {\n'
        + '        await rewindBeforeSend({\n'
        + '          threadKey,\n'
        + '          environmentId: thread.environmentId,\n'
        + '          threadId: thread.id,\n'
        + '          busy: activeThreadBusy,\n'
        + '        });\n'
        + '      } catch (error) {\n'
        + '        setThreadComposerError(\n'
        + '          threadKey,\n'
        + '          error instanceof Error ? error.message : "The conversation did not rewind.",\n'
        + '        );\n'
        + '        return null;\n'
        + '      }\n\n'],
  ],
  'apps/mobile/src/features/threads/ThreadFeed.tsx': [
    ['import { ControlPillMenu } from "../../components/ControlPill";\n',
      'import {\n  SENT_MESSAGE_LABELS_EN,\n  SentMessageMenu,\n} from "../rubato-message-edit/SentMessageMenu";\n'],
    ['          <View\n            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"\n',
      '          <SentMessageMenu\n'
        + '            threadKey={scopedThreadKey(props.environmentId, props.threadId)}\n'
        + '            message={message}\n'
        + '            companion={false}\n'
        + '            editable={\n'
        + '              !entry.pendingMessage &&\n'
        + '              message.attachments.length === 0 &&\n'
        + '              (message.context?.records.length ?? 0) === 0\n'
        + '            }\n'
        + '            labels={SENT_MESSAGE_LABELS_EN}\n'
        + '            style={{ alignSelf: "stretch" }}\n'
        + '            contentStyle={{ alignItems: "flex-end" }}\n'
        + '          >\n'],
    ['          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">\n',
      '          </SentMessageMenu>\n'],
  ],
  'apps/mobile/src/features/threads/ThreadDetailScreen.tsx': [
    ['import { scopedThreadKey } from "../../lib/scopedEntities";\n',
      'import {\n  SENT_MESSAGE_LABELS_EN,\n  SentMessageEditBanner,\n} from "../rubato-message-edit/SentMessageMenu";\n'],
    ['                  {props.queuedRunEdit !== null ? (\n',
      '                  <SentMessageEditBanner\n'
        + '                    threadKey={selectedThreadKey}\n'
        + '                    labels={SENT_MESSAGE_LABELS_EN}\n'
        + '                  />\n'],
  ],
};
