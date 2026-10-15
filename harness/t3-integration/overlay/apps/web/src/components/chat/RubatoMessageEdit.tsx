import type { EnvironmentId, MessageId, OrchestrationMessageContext } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { PencilIcon } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { resolveUserMessageContext } from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import { type ChatAttachment, type ChatMessage, isImageAttachment } from "~/types";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Editing a sent message in place, as Codex does (turn-actions-edits.mjs). The pencil under
// a message of mine turns its bubble into an editor; sending the edit rewinds to before
// that message and sends the edited one in its place. Files stay as they are: only the
// conversation rewinds. A reply's own rewind and fork stay on the reply's row.
//
// The text keeps its inline attachments (an image pasted mid-sentence is a context link
// in the text). The editor shows each link as a numbered placeholder, so it can be moved
// or deleted, and the send puts the links back. The rewind prunes the files of the
// messages it drops, so the attachments are uploaded again before it.

type ContextRecord = OrchestrationMessageContext["records"][number];

export interface RubatoMessageEdit {
  readonly messageId: MessageId;
  /** The checkpoint count to rewind to: the turns before this message. */
  readonly turnCount: number;
  readonly text: string;
  readonly records: ReadonlyArray<ContextRecord>;
  /** The original attachments the edited message keeps, in their order. */
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface EditableText {
  readonly text: string;
  /** The context links the placeholders stand for; placeholder #n is links[n - 1]. */
  readonly links: ReadonlyArray<string>;
}

const PLACEHOLDER = /⟦[^⟦⟧]*#(\d+)⟧/g;

/** The text an editor shows: each context link becomes `⟦label #n⟧`. */
export function toEditableText(text: string): EditableText {
  const links: string[] = [];
  const editable = replaceComposerContextReferences(text, (occurrence) => {
    links.push(occurrence.source);
    return `⟦${occurrence.label.replace(/[⟦⟧]/g, "")} #${links.length}⟧`;
  });
  return { text: editable, links };
}

/** The edited text with its placeholders turned back into the links they stand for. */
export function fromEditableText(edited: string, links: ReadonlyArray<string>): string {
  return edited.replace(
    PLACEHOLDER,
    (placeholder, index: string) => links[Number(index) - 1] ?? placeholder,
  );
}

/** The text with each context link reduced to its label, for a composer that lacks the records. */
export const plainTextOf = (text: string): string =>
  replaceComposerContextReferences(text, (occurrence) => occurrence.label);

const attachmentOf = (record: ContextRecord): string | undefined => {
  const value = (record as { kind?: unknown; attachmentId?: unknown } | null) ?? null;
  return (value?.kind === "image" || value?.kind === "file") &&
    typeof value.attachmentId === "string"
    ? value.attachmentId
    : undefined;
};
const contextIdOf = (record: ContextRecord): string | undefined => {
  const value = (record as { contextId?: unknown } | null)?.contextId;
  return typeof value === "string" ? value : undefined;
};

/**
 * What the edited message carries: the records whose links are still in the text, and the
 * attachments except those only a deleted link used.
 */
export function keptContext(
  text: string,
  records: ReadonlyArray<ContextRecord>,
  attachments: ReadonlyArray<ChatAttachment>,
): { readonly records: ContextRecord[]; readonly attachments: ChatAttachment[] } {
  const linked = new Set(
    collectComposerContextReferences(text).map((occurrence) => occurrence.contextId as string),
  );
  const kept = records.filter((record) => {
    const contextId = contextIdOf(record);
    return contextId !== undefined && linked.has(contextId);
  });
  const stillUsed = new Set(kept.map(attachmentOf).filter((id) => id !== undefined));
  const dropped = new Set(
    records
      .filter((record) => !kept.includes(record))
      .map(attachmentOf)
      .filter((id): id is string => id !== undefined && !stillUsed.has(id)),
  );
  return {
    records: kept,
    attachments: attachments.filter((attachment) => !dropped.has(attachment.id)),
  };
}

/** The records with each attachment id moved to its new upload. */
export function withUploadedAttachments(
  records: ReadonlyArray<ContextRecord>,
  uploadedIdByOriginal: ReadonlyMap<string, string>,
): ContextRecord[] {
  return records.map((record) => {
    const original = attachmentOf(record);
    const uploaded = original === undefined ? undefined : uploadedIdByOriginal.get(original);
    return uploaded === undefined
      ? record
      : ({ ...(record as object), attachmentId: uploaded } as ContextRecord);
  });
}

/**
 * Uploads a message's attachments again from their bytes. `release` discards the uploads;
 * call it after the send (it is then a no-op on the server) or when giving up.
 */
export async function uploadAgain(
  environmentId: EnvironmentId,
  attachments: ReadonlyArray<ChatAttachment>,
  files: ReadonlyArray<File>,
): Promise<{ readonly uploaded: ReadonlyArray<ChatAttachment>; readonly release: () => void }> {
  const drafts: Array<ComposerImageAttachment | ComposerFileAttachment> = files.map(
    (file, index) => {
      const base = { id: randomUUID(), name: file.name, mimeType: file.type, sizeBytes: file.size };
      const original = attachments[index];
      return original !== undefined && isImageAttachment(original)
        ? {
            ...base,
            type: "image" as const,
            previewUrl: URL.createObjectURL(file),
            file,
            ...(original.source ? { source: original.source } : {}),
          }
        : { ...base, type: "file" as const, file };
    },
  );
  const release = () => {
    for (const draft of drafts) {
      releaseAttachmentUpload(draft.id);
      if (draft.type === "image") URL.revokeObjectURL(draft.previewUrl);
    }
  };
  for (const draft of drafts) startAttachmentUpload({ environmentId, image: draft });
  await awaitAttachmentUploads(drafts.map((draft) => draft.id));
  const uploaded = getUploadedAttachments({ environmentId, images: drafts });
  if (uploaded === null) {
    release();
    throw new Error("Could not upload this message's attachments again.");
  }
  return { uploaded, release };
}

// Which message is being edited, per thread, and who sends the edit.
const editing = new Map<string, MessageId>();
const hosts = new Map<string, { current: (edit: RubatoMessageEdit) => Promise<void> }>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setEditing(threadKey: string, messageId: MessageId | undefined) {
  if (messageId === undefined) editing.delete(threadKey);
  else editing.set(threadKey, messageId);
  for (const listener of listeners) listener();
}

export function useRubatoMessageEditing(threadKey: string, messageId: MessageId): boolean {
  const read = () => editing.get(threadKey) === messageId;
  return useSyncExternalStore(subscribe, read, read);
}

/** ChatView lends the edit its rewind and send. */
export function useRubatoMessageEditHost(
  threadKey: string,
  submit: (edit: RubatoMessageEdit) => Promise<void>,
) {
  const ref = useRef(submit);
  useLayoutEffect(() => {
    ref.current = submit;
  });
  useEffect(() => {
    const host = ref;
    hosts.set(threadKey, host);
    return () => {
      if (hosts.get(threadKey) === host) hosts.delete(threadKey);
      setEditing(threadKey, undefined);
    };
  }, [threadKey]);
}

/** The pencil under a message of mine. */
export function RubatoEditMessageButton(props: {
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly busy: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={props.busy}
            onClick={() => setEditing(props.threadKey, props.messageId)}
            aria-label="Edit message"
          />
        }
      >
        <PencilIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit message</TooltipPopup>
    </Tooltip>
  );
}

const fitHeight = (element: HTMLTextAreaElement) => {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
};

/** The bubble's editor: Enter sends (rewinding to before the message), Escape cancels. */
export function RubatoMessageEditor(props: {
  readonly threadKey: string;
  readonly message: ChatMessage;
  readonly turnCount: number;
}) {
  const { threadKey, message, turnCount } = props;
  const [initial] = useState(() => {
    const resolved = resolveUserMessageContext(message);
    return { ...toEditableText(resolved.text), records: resolved.records };
  });
  const [draft, setDraft] = useState(initial.text);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    fitHeight(element);
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const cancel = () => setEditing(threadKey, undefined);
  const text = fromEditableText(draft, initial.links).trim();
  const send = async () => {
    const host = hosts.get(threadKey);
    if (sending || text.length === 0 || !host) return;
    const kept = keptContext(text, initial.records, message.attachments ?? []);
    setSending(true);
    try {
      await host.current({ messageId: message.id, turnCount, text, ...kept });
      setEditing(threadKey, undefined);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not send the edit",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={area}
        value={draft}
        disabled={sending}
        rows={1}
        aria-label="Edit message"
        onChange={(event) => {
          setDraft(event.target.value);
          fitHeight(event.target);
        }}
        onKeyDown={onKeyDown}
        className="max-h-[50vh] w-full resize-none overflow-y-auto bg-transparent text-sm leading-relaxed outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="xs" variant="ghost-muted" disabled={sending} onClick={cancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={sending || text.length === 0} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
