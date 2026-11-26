// Downloads a sent message's attachments from the Mac into local composer draft files so editing a
// photo or file turn brings its attachments into the composer before the rewind prunes the originals.
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import {
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { assetEnvironment } from "../../state/assets";
import { environmentSession } from "../../state/session";

export interface RestoredMessageAttachments {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly failedCount: number;
}

async function restoreOne(
  environmentId: EnvironmentId,
  httpBaseUrl: string,
  attachment: Extract<ChatAttachment, { type: "image" | "file" }>,
  signal: AbortSignal,
): Promise<DraftComposerAttachment | null> {
  if (signal.aborted) return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
        },
      },
    }),
    { refresh: true, reportFailure: false },
  );
  if (signal.aborted || result._tag === "Failure") return null;
  const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  if (!url) return null;
  const temporary = await downloadAttachmentForPreview({
    attachment: { name: attachment.name, mimeType: attachment.mimeType },
    url,
    signal,
  });
  if (!temporary) return null;
  let fileUri: string;
  try {
    fileUri = await persistComposerAttachmentFile(
      temporary.uri,
      attachment.name,
      attachment.type === "image"
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
  } finally {
    temporary.dispose();
  }
  if (signal.aborted) {
    await removePersistedComposerAttachmentFile(fileUri).catch(() => undefined);
    return null;
  }
  const { File } = await import("expo-file-system");
  const sizeBytes = new File(fileUri).size || attachment.sizeBytes;
  const common = {
    id: uuidv4(),
    fileUri,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes,
  };
  return attachment.type === "image"
    ? {
        ...common,
        type: "image",
        previewUri: fileUri,
        ...(attachment.source ? { source: attachment.source } : {}),
      }
    : {
        ...common,
        type: "file",
        ...(attachment.source ? { source: attachment.source } : {}),
      };
}

export async function restoreMessageAttachments(
  environmentId: EnvironmentId,
  attachments: ReadonlyArray<ChatAttachment>,
  signal: AbortSignal,
): Promise<RestoredMessageAttachments> {
  const restorable = attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { type: "image" | "file" }> =>
      attachment.type === "image" || attachment.type === "file",
  );
  if (restorable.length === 0 || signal.aborted) return { attachments: [], failedCount: 0 };
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) return { attachments: [], failedCount: restorable.length };

  const restored: DraftComposerAttachment[] = [];
  let failedCount = 0;
  for (const attachment of restorable) {
    if (signal.aborted) break;
    try {
      const imported = await restoreOne(environmentId, connection.value.httpBaseUrl, attachment, signal);
      if (imported) restored.push(imported);
      else if (!signal.aborted) failedCount += 1;
    } catch {
      if (!signal.aborted) failedCount += 1;
    }
  }
  if (signal.aborted) {
    await Promise.all(
      restored.map((item) =>
        item.fileUri ? removePersistedComposerAttachmentFile(item.fileUri).catch(() => undefined) : Promise.resolve(),
      ),
    );
    return { attachments: [], failedCount: 0 };
  }
  return { attachments: restored, failedCount };
}
