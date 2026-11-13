// The pictures and files a message carries, drawn with the thread feed's own renderers
// (ThreadFeed MessageAttachmentImage/File/Unknown): a picture in place that opens full screen, a
// video as a tile that plays, any other file as a row that opens it.
import type { ChatAttachment } from "@t3tools/contracts";
import { View } from "react-native";

import {
  isFileAttachment,
  isImageAttachment,
  MessageAttachmentFile,
  MessageAttachmentImage,
  MessageAttachmentUnknown,
} from "../threads/ThreadFeed";
import type { RoomMedia } from "./roomMedia";

export function BubbleAttachments(props: { readonly attachments: ReadonlyArray<ChatAttachment>; readonly media: RoomMedia }) {
  const { media } = props;
  if (props.attachments.length === 0) return null;
  return (
    <View className="gap-2">
      {props.attachments.map((attachment) =>
        isImageAttachment(attachment) ? (
          <MessageAttachmentImage
            key={attachment.id}
            environmentId={media.environmentId}
            attachmentId={attachment.id}
            name={attachment.name}
            mimeType={attachment.mimeType}
            className="h-[180px] w-[220px] rounded-[14px]"
            onPressPreview={media.onPressPreview}
          />
        ) : isFileAttachment(attachment) ? (
          <MessageAttachmentFile
            key={attachment.id}
            environmentId={media.environmentId}
            attachment={attachment}
            onPressPreview={media.onPressPreview}
            onPressVideo={media.onPressVideo}
          />
        ) : (
          <MessageAttachmentUnknown key={attachment.id} name={String((attachment as { name?: unknown }).name ?? "")} />
        ),
      )}
    </View>
  );
}
