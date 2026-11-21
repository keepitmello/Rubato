// The picture on a companion's profile (intent companion-manage): the round face with a camera badge
// whose menu uploads a photo, picks a picture from the conversation, or asks the companion to draw
// one. A chosen picture is cropped round here — square, at most 1024 px, a jpeg, png or webp data URL
// within 2 MB — and stored by the server outside the companion's home (set-avatar), so its records
// stay as they are. Asking it to draw opens its room with a draft; what it draws comes back as a card
// there.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { CameraIcon, FolderOpenIcon, ImagesIcon, PaletteIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { selectMessageImageResources } from "../../session-logic";
import { useQuietThreadProjection } from "../../state/entities";
import {
  acceptCompanionAvatar,
  rubatoCompanion,
  useUiText,
  type CompanionChoice,
} from "../../state/rubatoCompanion";
import {
  acceptableAvatar,
  avatarSide,
  CROP_ZOOM_MAX,
  cropSquare,
  initialCrop,
  panCrop,
  zoomCrop,
  type CropSquare,
  type CropView,
} from "../../state/rubatoCompanionModel";
import type { ChatMessage } from "../../types";
import { RubatoCompanionFace } from "../chat/RubatoCompanionFace";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

/** The crop's preview, in CSS px. */
const PREVIEW_PX = 288;

/** Draws the crop at its stored size and encodes it within the route's limits. */
export function encodeAvatar(image: CanvasImageSource, square: CropSquare): string {
  const side = avatarSide(square.size);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window cannot draw pictures.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, square.sx, square.sy, square.size, square.size, 0, 0, side, side);
  for (const [type, quality] of [
    ["image/webp", 0.92],
    ["image/jpeg", 0.9],
    ["image/jpeg", 0.8],
    ["image/jpeg", 0.65],
    ["image/jpeg", 0.5],
  ] as const) {
    const url = canvas.toDataURL(type, quality);
    if (acceptableAvatar(url)) return url;
  }
  throw new Error("The picture is still over 2 MB after compressing it.");
}

/** Loads a picture from a URL (data, blob or the server's) as an element the canvas may read. */
async function loadPicture(source: Blob | string): Promise<{ image: HTMLImageElement; release: () => void }> {
  const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This picture could not be opened. Try a JPEG, PNG or WebP.");
  }
  return { image, release: () => URL.revokeObjectURL(url) };
}

function CropDialog({
  picture,
  companion,
  environmentId,
  onClose,
}: {
  picture: { image: HTMLImageElement; release: () => void };
  companion: CompanionChoice;
  environmentId: EnvironmentId | null;
  onClose: () => void;
}) {
  const width = picture.image.naturalWidth;
  const height = picture.image.naturalHeight;
  const [view, setView] = useState<CropView>(() => initialCrop(width, height));
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => picture.release(), [picture]);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const scale = window.devicePixelRatio || 1;
    element.width = Math.round(PREVIEW_PX * scale);
    element.height = Math.round(PREVIEW_PX * scale);
    const square = cropSquare(width, height, view);
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, element.width, element.height);
    context.drawImage(picture.image, square.sx, square.sy, square.size, square.size, 0, 0, element.width, element.height);
  }, [picture, view, width, height]);
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const last = drag.current;
    if (!last) return;
    drag.current = { x: event.clientX, y: event.clientY };
    setView((current) => panCrop(width, height, current, event.clientX - last.x, event.clientY - last.y, PREVIEW_PX));
  };
  const save = async () => {
    if (environmentId === null) return;
    setSaving(true);
    try {
      const image = encodeAvatar(picture.image, cropSquare(width, height, view));
      const { avatar } = await rubatoCompanion.setAvatar(environmentId, companion.id, image);
      acceptCompanionAvatar(companion.id, avatar, true);
      onClose();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not change the picture",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
    setSaving(false);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-sm" data-rubato-companion-crop="">
        <DialogHeader>
          <DialogTitle>Crop the picture</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col items-center gap-3">
          <div className="relative overflow-hidden rounded-xl bg-muted" style={{ width: PREVIEW_PX, height: PREVIEW_PX }}>
            <canvas
              ref={canvas}
              aria-label="Drag to move the picture"
              style={{ width: PREVIEW_PX, height: PREVIEW_PX, touchAction: "none" }}
              className="cursor-grab active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onWheel={(event) => setView((current) => zoomCrop(width, height, current, current.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)))}
            />
            {/* The round window the face will show through; outside it is dimmed. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_999px_rgb(0_0_0/0.45)]" />
          </div>
          <input
            type="range"
            aria-label="Zoom"
            min={1}
            max={CROP_ZOOM_MAX}
            step={0.01}
            value={view.zoom}
            onChange={(event) => setView((current) => zoomCrop(width, height, current, Number(event.target.value)))}
            className="w-full accent-primary"
          />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || environmentId === null} onClick={() => void save()}>
            {saving ? <Spinner className="size-3.5" /> : null}
            Use this picture
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface ConversationPicture {
  readonly key: string;
  readonly url: string;
}

/** The pictures in the companion's room: what either side attached, and the pictures it drew for its profile. */
function ConversationPicturesDialog({
  companion,
  environmentId,
  onPick,
  onClose,
}: {
  companion: CompanionChoice;
  environmentId: EnvironmentId;
  onPick: (url: string) => void;
  onClose: () => void;
}) {
  const ref = useMemo(
    () => (companion.threadId ? scopeThreadRef(environmentId, ThreadId.make(companion.threadId)) : null),
    [environmentId, companion.threadId],
  );
  const projection = useQuietThreadProjection(ref)?.projection;
  const attachments = useMemo(() => {
    const messages = (projection?.messages ?? []) as unknown as ReadonlyArray<{ readonly attachments?: ChatMessage["attachments"] }>;
    return messages.flatMap((message) => message.attachments ?? []).reverse();
  }, [projection]);
  const resources = useMemo(() => selectMessageImageResources(attachments), [attachments]);
  const urls = useAssetUrls(environmentId, resources);
  const [drawn, setDrawn] = useState<ConversationPicture[]>([]);
  useEffect(() => {
    let live = true;
    rubatoCompanion.proposals(environmentId, companion.id).then(
      ({ proposals }) => {
        if (!live) return;
        setDrawn(
          [...proposals]
            .reverse()
            .flatMap((proposal) => (proposal.kind === "avatar" && proposal.image ? [{ key: `drawn:${proposal.id}`, url: proposal.image.url }] : [])),
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [environmentId, companion.id]);
  const pictures: ConversationPicture[] = [
    ...drawn,
    ...resources.flatMap((resource, index) => (urls[index] ? [{ key: resource.attachmentId, url: urls[index]! }] : [])),
  ];
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg" data-rubato-companion-pictures="">
        <DialogHeader>
          <DialogTitle>Pick a picture from the conversation</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {pictures.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">No pictures in the conversation yet.</p>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-4 gap-2 overflow-y-auto">
              {pictures.map((picture) => (
                <button
                  key={picture.key}
                  type="button"
                  onClick={() => onPick(picture.url)}
                  className="aspect-square cursor-pointer overflow-hidden rounded-lg border border-border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img src={picture.url} alt="" className="size-full object-cover" draggable={false} />
                </button>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The menu under the camera badge. */
function PictureMenu({
  title,
  canTalk,
  onUpload,
  onPick,
  onDraw,
  onClose,
}: {
  title: string;
  canTalk: boolean;
  onUpload: () => void;
  onPick: () => void;
  onDraw: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const item = "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden disabled:cursor-default disabled:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground";
  return (
    <div
      ref={menu}
      role="menu"
      data-rubato-companion-picture-menu=""
      className="absolute top-full left-1/2 z-30 mt-2 w-60 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <button type="button" role="menuitem" className={item} onClick={() => { onClose(); onUpload(); }}>
        <FolderOpenIcon aria-hidden="true" />
        <span>Upload a photo</span>
      </button>
      <button type="button" role="menuitem" className={item} disabled={!canTalk} onClick={() => { onClose(); onPick(); }}>
        <ImagesIcon aria-hidden="true" />
        <span>Pick from the conversation</span>
      </button>
      <button type="button" role="menuitem" className={item} disabled={!canTalk} onClick={() => { onClose(); onDraw(); }}>
        <PaletteIcon aria-hidden="true" />
        <span>{`Ask ${title} to draw one`}</span>
      </button>
    </div>
  );
}

/** The profile's round picture with its camera badge, and everything the badge opens. */
export function RubatoCompanionPicture({
  companion,
  environmentId,
  onAskToDraw,
}: {
  companion: CompanionChoice;
  environmentId: EnvironmentId | null;
  onAskToDraw: () => void;
}) {
  const name = useUiText(companion.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picture, setPicture] = useState<{ image: HTMLImageElement; release: () => void } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const open = useCallback(async (source: Blob | string) => {
    try {
      setPicture(await loadPicture(source));
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not open the picture",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return (
    <div className="relative size-24 shrink-0" data-rubato-companion-picture="">
      <RubatoCompanionFace companion={companion} className="size-24 border-2 border-border text-3xl" />
      <button
        type="button"
        aria-label="Change the picture"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Change the picture"
        onClick={() => setMenuOpen((value) => !value)}
        className="absolute -right-0.5 -bottom-0.5 flex size-8 cursor-pointer items-center justify-center rounded-full border-[3px] border-background bg-primary text-primary-foreground shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
      >
        <CameraIcon aria-hidden="true" />
      </button>
      {menuOpen ? (
        <PictureMenu
          title={name}
          canTalk={companion.threadId !== null}
          onUpload={() => file.current?.click()}
          onPick={() => setPicking(true)}
          onDraw={onAskToDraw}
          onClose={closeMenu}
        />
      ) : null}
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
        hidden
        aria-label="Upload a photo"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (chosen) void open(chosen);
        }}
      />
      {picking && environmentId !== null ? (
        <ConversationPicturesDialog
          companion={companion}
          environmentId={environmentId}
          onClose={() => setPicking(false)}
          onPick={(url) => {
            setPicking(false);
            void open(url);
          }}
        />
      ) : null}
      {picture ? (
        <CropDialog picture={picture} companion={companion} environmentId={environmentId} onClose={() => setPicture(null)} />
      ) : null}
    </div>
  );
}

