// Editing a message the person already sent, from a long press on its bubble, in a thread and in
// a companion's room (user 1987aa80: "길게 눌러서 수정 가능하게 하고 수정하면 그 턴으로 리와인드").
// The message's words go into the composer, and sending them rewinds the conversation to just
// before that message and sends the edit in its place, as the desktop's pencil does
// (web chat/RubatoMessageEdit.tsx). Files stay as they are: only the conversation rewinds.
//
// Where the rewind lands is the Mac's answer. A thread goes back to the checkpoint of the latest
// turn before the message (POST /rubato/message-rewind/target, then T3's checkpoint rollback);
// a companion's room has no checkpoints, so the message names the place itself
// (POST /rubato/companion-room/rewind). Nothing rewinds while a turn runs: the Mac refuses, and
// the edit waits in the composer to be sent again.
import {
  replaceComposerContextReferences,
  stripAttachmentOnlyBootstrapPrompt,
} from "@t3tools/shared/composerContextReferences";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import type { ChatAttachment, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { retainComposerAttachmentFileForPreview } from "../../lib/composerAttachmentPreviewRetention";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { postRubato } from "../companions/rubatoHttp";
import { answerRewindBeforeSend, type RewindBeforeSendInput } from "./beforeSend";
import { restoreMessageAttachments } from "./restoreAttachments";
import { appAtomRegistry } from "../../state/atom-registry";
import { setThreadComposerError } from "../../state/thread-composer-error";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachments,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerContextImporting,
  setComposerDraftText,
} from "../../state/use-composer-drafts";

export interface EditableSentMessage {
  readonly id: MessageId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}

export interface SentMessageEdit {
  readonly messageId: MessageId;
  /** A companion's room: rewound by the message itself, not by a checkpoint. */
  readonly companion: boolean;
  /** The draft the composer held before the edit took it over, given back on cancel. */
  readonly previousDraft: string;
  readonly previousAttachments: ReadonlyArray<DraftComposerAttachment>;
}

/** Edits in progress, keyed by the thread's scoped key (`${environmentId}:${threadId}`). */
export const sentMessageEditsAtom = Atom.make<Readonly<Record<string, SentMessageEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("rubato:sent-message-edits"),
);

const restoreControllers = new Map<string, AbortController>();
const previousAttachmentHolds = new Map<string, ReadonlyArray<() => void>>();

function abortAttachmentRestore(threadKey: string) {
  const controller = restoreControllers.get(threadKey);
  if (!controller) return;
  restoreControllers.delete(threadKey);
  controller.abort();
  setComposerContextImporting(threadKey, false);
}

function holdPreviousAttachments(
  threadKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
) {
  releasePreviousAttachmentHolds(threadKey);
  if (attachments.length === 0) return;
  const holds = attachments
    .filter(isFileBackedComposerAttachment)
    .map(retainComposerAttachmentFileForPreview);
  if (holds.length > 0) previousAttachmentHolds.set(threadKey, holds);
}

function releasePreviousAttachmentHolds(threadKey: string) {
  const holds = previousAttachmentHolds.get(threadKey);
  if (!holds) return;
  previousAttachmentHolds.delete(threadKey);
  for (const release of holds) release();
}

const isMediaDraftAttachment = (attachment: DraftComposerAttachment): boolean =>
  attachment.type === "image" ||
  imageMimeType(attachment) !== null ||
  videoMimeType(attachment) !== null;

export const getSentMessageEdit = (threadKey: string): SentMessageEdit | null =>
  appAtomRegistry.get(sentMessageEditsAtom)[threadKey] ?? null;

function setEdit(threadKey: string, edit: SentMessageEdit | null) {
  const next = { ...appAtomRegistry.get(sentMessageEditsAtom) };
  if (edit) next[threadKey] = edit;
  else delete next[threadKey];
  appAtomRegistry.set(sentMessageEditsAtom, next);
}

/**
 * The words of a sent message as the composer takes them: image/file links come along as
 * attachments in the strip instead, bootstrap placeholder text is stripped, and other context
 * links become their labels.
 */
export const editableText = (text: string): string =>
  stripAttachmentOnlyBootstrapPrompt(
    replaceComposerContextReferences(text, (occurrence) =>
      occurrence.kind === "image" || occurrence.kind === "file" ? "" : occurrence.label,
    ),
  ).trim();

/** The composer takes over the message's words and attachments; what it held comes back on cancel. */
export function beginSentMessageEdit(
  threadKey: string,
  message: EditableSentMessage,
  companion: boolean,
  environmentId?: EnvironmentId,
) {
  abortAttachmentRestore(threadKey);
  const current = getSentMessageEdit(threadKey);
  const snapshot = current ? null : getComposerDraftSnapshot(threadKey);
  const previousDraft = current ? current.previousDraft : (snapshot?.text ?? "");
  const previousAttachments = current ? current.previousAttachments : (snapshot?.attachments ?? []);
  if (!current) holdPreviousAttachments(threadKey, previousAttachments);
  setEdit(threadKey, { messageId: message.id, companion, previousDraft, previousAttachments });
  setComposerDraftText(threadKey, editableText(message.text));
  replaceComposerDraftAttachments(threadKey, []);

  const attachments = message.attachments ?? [];
  if (environmentId && attachments.length > 0) {
    const controller = new AbortController();
    restoreControllers.set(threadKey, controller);
    setComposerContextImporting(threadKey, true);
    void restoreMessageAttachments(environmentId, attachments, controller.signal)
      .then((restored) => {
        if (controller.signal.aborted || getSentMessageEdit(threadKey)?.messageId !== message.id) {
          return;
        }
        const media = restored.attachments.filter(isMediaDraftAttachment);
        const files = restored.attachments.filter((item) => !isMediaDraftAttachment(item));
        if (media.length > 0) appendComposerDraftAttachments(threadKey, media, { restore: true });
        if (files.length > 0)
          appendComposerDraftAttachments(threadKey, files, { appendReference: true });
        if (restored.failedCount > 0) {
          setThreadComposerError(
            threadKey,
            "Could not load this message's attachments. You can still edit and send, or attach them again.",
          );
        }
      })
      .finally(() => {
        if (restoreControllers.get(threadKey) === controller) {
          restoreControllers.delete(threadKey);
          setComposerContextImporting(threadKey, false);
        }
      });
  }
}

export function cancelSentMessageEdit(threadKey: string) {
  abortAttachmentRestore(threadKey);
  const edit = getSentMessageEdit(threadKey);
  if (!edit) return;
  setEdit(threadKey, null);
  setComposerDraftText(threadKey, edit.previousDraft);
  replaceComposerDraftAttachments(threadKey, edit.previousAttachments);
  releasePreviousAttachmentHolds(threadKey);
}

export class SentMessageEditError extends Schema.TaggedError<SentMessageEditError>()(
  "SentMessageEditError",
  { message: Schema.String },
) {}

/**
 * Whether the conversation still holds the message. A rewind does not delete it: T3's revert and
 * the companion room's both leave it on a rolled-back run, which the feed no longer shows.
 */
export const messageStillThere = (environmentId: EnvironmentId, threadId: ThreadId, messageId: MessageId) => {
  const projection = appAtomRegistry.get(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection;
  const message = projection?.messages.find((candidate) => candidate.id === messageId);
  if (!projection || !message) return false;
  return message.runId == null
    || !projection.runs.some((run) => run.id === message.runId && run.status === "rolled_back");
};

/** Resolves once the thread no longer holds the message, so the edit is sent after the rewind. */
function untilGone(environmentId: EnvironmentId, threadId: ThreadId, messageId: MessageId, timeoutMs = 20_000) {
  return new Promise<void>((resolve, reject) => {
    if (!messageStillThere(environmentId, threadId, messageId)) return resolve();
    const atom = environmentThreadDetails.threadAtom({ environmentId, threadId });
    const stop = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new SentMessageEditError({ message: "The Mac did not finish rewinding." }));
    }, timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(atom, () => {
      if (messageStillThere(environmentId, threadId, messageId)) return;
      stop();
      resolve();
    });
  });
}

/**
 * Before the composer sends: when the person is editing a sent message, rewind to just before it.
 * Resolves when there is nothing to rewind or the rewind is done (the edit then ends and the
 * composer sends as usual); throws, with the edit kept, when it cannot rewind now.
 */
export async function rewindBeforeSend(input: RewindBeforeSendInput): Promise<void> {
  const edit = getSentMessageEdit(input.threadKey);
  if (!edit) return;
  if (input.busy) throw new SentMessageEditError({
      message: "It is still working. Send the edit again once it has finished, or stop it first.",
    });
  if (messageStillThere(input.environmentId, input.threadId, edit.messageId)) {
    if (edit.companion) {
      await postRubato(input.environmentId, "/rubato/companion-room", "rewind", { threadId: input.threadId, messageId: edit.messageId }, { timeoutMs: 30_000 });
    } else {
      const target = await postRubato<{ turnCount: number; checkpointId: string; scopeId: string }>(
        input.environmentId,
        "/rubato/message-rewind",
        "target",
        { threadId: input.threadId, messageId: edit.messageId },
      );
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.revertCheckpoint,
        {
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            checkpointId: target.checkpointId,
            scopeId: target.scopeId,
            turnCount: target.turnCount,
            restoreFiles: false,
          },
        },
        { label: "edit sent message", reportFailure: false, reportDefect: true },
      );
      if (result._tag === "Failure") throw new SentMessageEditError({ message: "The Mac did not rewind the conversation." });
    }
    await untilGone(input.environmentId, input.threadId, edit.messageId);
  }
  abortAttachmentRestore(input.threadKey);
  setEdit(input.threadKey, null);
  releasePreviousAttachmentHolds(input.threadKey);
  if (edit.previousAttachments.length > 0) {
    scheduleUnusedComposerAttachmentCleanup(edit.previousAttachments);
  }
}

answerRewindBeforeSend(rewindBeforeSend);
