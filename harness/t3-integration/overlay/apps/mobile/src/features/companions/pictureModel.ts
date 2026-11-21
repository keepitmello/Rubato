// A companion's picture as the person sets it from the phone (intent companion-manage): from the
// camera, the album, a picture in its room, or one it drew. Whatever the source, the person places
// it in a circle (AvatarCropScreen) and the phone sends the square around that circle to the Mac,
// which keeps it for every device. No native module here, so tests read it; the crop screen's
// gestures call the placing math on the UI thread, hence the worklet marks.
import type { AssetResource, ChatAttachment, ThreadId } from "@t3tools/contracts";

import { fileLines, splitFileLines } from "./roomModel";

/** The longest edge sent to the Mac: sharp on the largest avatar either app draws, small to send. */
export const AVATAR_EDGE = 1024;
/** How far the person can zoom in past the size where the picture just covers the circle. */
export const MAX_ZOOM = 5;

export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** The scale (points per pixel) at which the picture's shorter side just spans the circle. */
export function coverScale(image: Size, diameter: number): number {
  "worklet";
  return diameter / Math.max(1, Math.min(image.width, image.height));
}

/** The zoom kept between 1 (covering the circle) and MAX_ZOOM. */
export function clampZoom(zoom: number): number {
  "worklet";
  return Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
}

/**
 * How far the picture's center may move from the circle's center, in points, so the circle stays
 * covered: half of what the drawn picture has beyond the circle on each axis.
 */
export function clampOffset(image: Size, diameter: number, zoom: number, offset: Offset): Offset {
  "worklet";
  const scale = coverScale(image, diameter) * clampZoom(zoom);
  const limitX = Math.max(0, (image.width * scale - diameter) / 2);
  const limitY = Math.max(0, (image.height * scale - diameter) / 2);
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  return { x: clamp(offset.x, limitX), y: clamp(offset.y, limitY) };
}

export interface CropRect {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The square of the picture, in its pixels, that the circle shows: the circle's center sits
 * `offset` points away from the picture's center (positive x: the picture moved right). Whole
 * pixels, inside the picture.
 */
export function cropRect(image: Size, diameter: number, zoom: number, offset: Offset): CropRect {
  const z = clampZoom(zoom);
  const scale = coverScale(image, diameter) * z;
  const placed = clampOffset(image, diameter, z, offset);
  const side = Math.min(image.width, image.height, Math.round(diameter / scale));
  const centerX = image.width / 2 - placed.x / scale;
  const centerY = image.height / 2 - placed.y / scale;
  const originX = Math.min(image.width - side, Math.max(0, Math.round(centerX - side / 2)));
  const originY = Math.min(image.height - side, Math.max(0, Math.round(centerY - side / 2)));
  return { originX, originY, width: side, height: side };
}

/** The edge the cropped square is sent at: its own size, at most AVATAR_EDGE. */
export const avatarEdge = (crop: CropRect) => Math.min(crop.width, AVATAR_EDGE);

/** A picture somewhere in the room, as the asset the Mac serves it as. */
export interface RoomPicture {
  readonly key: string;
  readonly resource: AssetResource;
}

export interface PictureMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}

const PICTURE_FILE = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
const isPictureAttachment = (attachment: ChatAttachment) =>
  attachment.type === "image" || /^image\//i.test(attachment.mimeType);

/**
 * The pictures in a room, newest first, each once: what the person sent (attachments) and what the
 * companion sent as an embedded file line (`![name](</abs>)`, a picture by its extension).
 */
export function roomPictures(messages: ReadonlyArray<PictureMessage>, threadId: ThreadId): RoomPicture[] {
  const seen = new Set<string>();
  const out: RoomPicture[] = [];
  const sorted = [...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const message of sorted) {
    if (message.role === "system") continue;
    const found: RoomPicture[] = [];
    for (const attachment of message.attachments ?? [])
      if (isPictureAttachment(attachment))
        found.push({
          key: `attachment:${attachment.id}`,
          resource: { _tag: "attachment", attachmentId: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType, disposition: "inline" },
        });
    for (const file of fileLines(splitFileLines(message.text).files))
      if (file.embed && PICTURE_FILE.test(file.path))
        found.push({ key: `file:${file.path}`, resource: { _tag: "media-file", threadId, path: file.path } });
    // A message's own pictures stay in their order; messages go newest first.
    for (const picture of found) {
      if (seen.has(picture.key)) continue;
      seen.add(picture.key);
      out.push(picture);
    }
  }
  return out;
}
