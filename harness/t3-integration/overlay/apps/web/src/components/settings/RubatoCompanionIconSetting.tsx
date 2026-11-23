import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { acceptCompanionIcon, rubatoCompanion, type CompanionChoice } from "../../state/rubatoCompanion";
import { RubatoCompanionRailIcon } from "../sidebar/RubatoSegnoIcon";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

async function encodeIcon(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024 || !["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose an SVG, PNG, JPEG or WebP file under 2 MB.");
  const url = URL.createObjectURL(file);
  try {
    // SVG is decoded only as an image (never inserted into the DOM), and only raster pixels are saved.
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    const side = 96;
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx || !image.naturalWidth || !image.naturalHeight) throw new Error("This icon could not be opened.");
    const scale = side / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    ctx.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function RubatoCompanionIconSetting({ companion, environmentId, onAsk }: {
  companion: CompanionChoice;
  environmentId: EnvironmentId | null;
  onAsk?: (() => void) | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const report = (cause: unknown) => toastManager.add({
    type: "error", title: "Could not change the sidebar icon",
    description: cause instanceof Error ? cause.message : String(cause),
  });
  const choose = async (file: File) => {
    setBusy(true);
    try { setPreview(await encodeIcon(file)); } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  const save = async (image: string | null) => {
    if (!environmentId || busy) return;
    setBusy(true);
    try {
      const { icon } = await rubatoCompanion.setIcon(environmentId, companion.id, image);
      acceptCompanionIcon(companion.id, icon);
      setPreview(undefined);
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted" aria-label={preview ? "Sidebar icon preview" : undefined}>
        <RubatoCompanionRailIcon companion={companion} {...(preview ? { preview } : {})} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium text-sm">Sidebar icon</h3>
        <p className="text-muted-foreground text-xs">Separate from the profile picture.</p>
      </div>
      <input ref={input} type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void choose(file);
        }} />
      {preview ? (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</Button>
          <Button size="sm" disabled={busy || !environmentId} onClick={() => void save(preview)}>Save icon</Button>
        </>
      ) : (
        <>
          {companion.iconVersion != null && (
            <Button size="sm" variant="ghost" disabled={busy || !environmentId} onClick={() => void save(null)}>Restore default</Button>
          )}
          <Button size="sm" variant="outline" disabled={busy || !environmentId} onClick={() => input.current?.click()}>Upload icon</Button>
          <Button size="sm" variant="outline" disabled={busy || !environmentId || !onAsk} onClick={onAsk}>Ask to draw an icon</Button>
        </>
      )}
    </section>
  );
}
