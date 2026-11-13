// Pictures, videos and files in a companion's room, drawn and opened the way a thread does it
// (ThreadFeed's markdown media and attachment handling): a picture or video a message carries
// shows in place and opens full screen, and a file opens in the file screen.
// The companion's files arrive as markdown lines with absolute paths (companion home.mjs
// filesMarkdown); the Mac serves any absolute path to a paired phone.
import { CommonActions, useNavigation } from "@react-navigation/native";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import type { ChatFileAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState } from "react";
import { Linking } from "react-native";

import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { normalizeNativeMarkdownUrl, resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { attachmentVideoPreviewSource } from "../../lib/videoPreviewSource";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { fileRoutePathSegments, isAbsolutePath, resolveWorkspaceRelativeFilePath } from "../files/filePath";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../threads/ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "../threads/ThreadMarkdownVideo";

export interface RoomMedia {
  readonly environmentId: EnvironmentId;
  readonly onLinkPress: (href: string) => void;
  readonly onImagePress: (href: string) => void;
  readonly resolveImageSource: ReturnType<typeof useMarkdownImageSource>;
  readonly renderImage: MarkdownImageRenderer;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
}

export function useRoomMedia(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
}) {
  const { environmentId, threadId, workspaceRoot } = input;
  const navigation = useNavigation();
  const [file, setFile] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const onPressPreview = useCallback((source: FilePreviewSource) => setFile((current) => current ?? source), []);
  const onPressVideo = useCallback(
    (attachment: ChatFileAttachment, sourceIdentifier: string) =>
      setVideo((current) => current ?? attachmentVideoPreviewSource(environmentId, attachment, sourceIdentifier)),
    [environmentId],
  );
  const openLink = useCallback(
    (href: string, imageEmbed = false) => {
      const media = resolveMarkdownMediaPreview(href, { environmentId, threadId, workspaceRoot, imageEmbed });
      if (media) {
        void Haptics.selectionAsync();
        if (media.kind === "video") setVideo((current) => current ?? media.source);
        else setFile((current) => current ?? media.source);
        return;
      }
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const path = resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path)
          ?? (isAbsolutePath(presentation.path) ? presentation.path : null);
        if (path) {
          void Haptics.selectionAsync();
          navigation.dispatch(
            CommonActions.navigate("ThreadFile", {
              environmentId: String(environmentId),
              threadId: String(threadId),
              path: fileRoutePathSegments(path),
              ...(presentation.line ? { line: String(presentation.line) } : {}),
            }),
          );
        }
        return;
      }
      if (presentation.href && /^https?:\/\//i.test(presentation.href)) void Linking.openURL(presentation.href).catch(() => undefined);
    },
    [environmentId, threadId, workspaceRoot, navigation],
  );
  const resolveImageSource = useMarkdownImageSource({ environmentId, threadId, workspaceRoot });
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMarkdownMediaPreview(image.href, { environmentId, threadId, workspaceRoot, imageEmbed: true });
      if (media?.kind === "video")
        return <ThreadMarkdownVideo key={image.href} source={{ ...media.source, name: image.alt ?? media.source.name }} />;
      const imageSource = classifyMarkdownImageSource(image.href, workspaceRoot);
      if (imageSource._tag === "Direct")
        return (
          <ThreadMarkdownImageView
            uri={normalizeNativeMarkdownUrl(imageSource.uri)}
            sourceKey={imageSource.uri}
            unavailable={false}
            alt={image.alt}
            actionsSource={media?.source.actionsSource}
            onPressPreview={onPressPreview}
          />
        );
      if (imageSource._tag === "Blocked") return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      return (
        <ThreadMarkdownImage
          environmentId={environmentId}
          resource={{ _tag: "media-file", threadId, path: imageSource.path }}
          alt={image.alt}
          srcFragment={markdownImageSourceFragment(image.href)}
          actionsSource={media?.source.actionsSource}
          onPressPreview={onPressPreview}
        />
      );
    },
    [environmentId, threadId, workspaceRoot, onPressPreview],
  );
  const media = useMemo<RoomMedia>(
    () => ({
      environmentId,
      onLinkPress: (href) => openLink(href),
      onImagePress: (href) => openLink(href, true),
      resolveImageSource,
      renderImage,
      onPressPreview,
      onPressVideo,
    }),
    [environmentId, openLink, resolveImageSource, renderImage, onPressPreview, onPressVideo],
  );
  const modals = (
    <>
      <FilePreviewModal source={file} onRequestClose={() => setFile(null)} />
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </>
  );
  return { media, modals };
}
