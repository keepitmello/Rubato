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
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { postRubato } from "../companions/rubatoHttp";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";

export interface SentMessageEdit {
  readonly messageId: MessageId;
  /** A companion's room: rewound by the message itself, not by a checkpoint. */
  readonly companion: boolean;
  /** The draft the composer held before the edit took it over, given back on cancel. */
  readonly previousDraft: string;
}

/** Edits in progress, keyed by the thread's scoped key (`${environmentId}:${threadId}`). */
export const sentMessageEditsAtom = Atom.make<Readonly<Record<string, SentMessageEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("rubato:sent-message-edits"),
);

export const getSentMessageEdit = (threadKey: string): SentMessageEdit | null =>
  appAtomRegistry.get(sentMessageEditsAtom)[threadKey] ?? null;

function setEdit(threadKey: string, edit: SentMessageEdit | null) {
  const next = { ...appAtomRegistry.get(sentMessageEditsAtom) };
  if (edit) next[threadKey] = edit;
  else delete next[threadKey];
  appAtomRegistry.set(sentMessageEditsAtom, next);
}

/** The words of a sent message as the composer takes them: context links become their labels. */
export const editableText = (text: string): string =>
  replaceComposerContextReferences(text, (occurrence) => occurrence.label).trim();

/** The composer takes over the message's words; what it held comes back on cancel. */
export function beginSentMessageEdit(threadKey: string, message: { readonly id: MessageId; readonly text: string }, companion: boolean) {
  const current = getSentMessageEdit(threadKey);
  const previousDraft = current ? current.previousDraft : getComposerDraftSnapshot(threadKey).text;
  setEdit(threadKey, { messageId: message.id, companion, previousDraft });
  setComposerDraftText(threadKey, editableText(message.text));
}

export function cancelSentMessageEdit(threadKey: string) {
  const edit = getSentMessageEdit(threadKey);
  if (!edit) return;
  setEdit(threadKey, null);
  setComposerDraftText(threadKey, edit.previousDraft);
}

export class SentMessageEditError extends Error {}

const messageStillThere = (environmentId: EnvironmentId, threadId: ThreadId, messageId: MessageId) =>
  appAtomRegistry
    .get(environmentThreadDetails.threadAtom({ environmentId, threadId }))
    ?.projection.messages.some((message) => message.id === messageId) ?? false;

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
      reject(new SentMessageEditError("The Mac did not finish rewinding."));
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
export async function rewindBeforeSend(input: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly busy: boolean;
}): Promise<void> {
  const edit = getSentMessageEdit(input.threadKey);
  if (!edit) return;
  if (input.busy) throw new SentMessageEditError("It is still working. Send the edit again once it has finished, or stop it first.");
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
      if (result._tag === "Failure") throw new SentMessageEditError("The Mac did not rewind the conversation.");
    }
    await untilGone(input.environmentId, input.threadId, edit.messageId);
  }
  setEdit(input.threadKey, null);
}
