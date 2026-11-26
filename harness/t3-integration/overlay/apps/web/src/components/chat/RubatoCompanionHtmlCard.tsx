// Inline live preview card for an HTML file attached in a companion's chat room.
// Renders the HTML directly inside the bubble in a sandboxed iframe (pointer-events disabled so
// wheel scrolling stays with the chat room and any click opens the full interactive viewer in the
// companion's right floating overlay drawer).
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Globe2Icon, Maximize2Icon } from "lucide-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useRightPanelStore } from "~/rightPanelStore";
import { cn } from "../../lib/utils";
import { workspaceAssetResource } from "../files/filePreviewMode";

const ABSOLUTE_PATH = /^(?:\/|[a-zA-Z]:[\\/])/;

function resolveAbsolutePath(path: string, cwd: string | undefined): string {
  if (ABSOLUTE_PATH.test(path) || !cwd) return path;
  return `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

export function RubatoCompanionHtmlCard({
  label,
  path,
  cwd,
  environmentId,
  threadRef,
}: {
  readonly label: string;
  readonly path: string;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
}) {
  const absolutePath = resolveAbsolutePath(path, cwd);
  const resource =
    environmentId && threadRef
      ? workspaceAssetResource({
          kind: "workspace-file",
          threadRef,
          draft: false,
          workspaceRoot: cwd ?? "",
          absolutePath,
        })
      : null;
  const assetUrl = useAssetUrlState(environmentId ?? null, resource);
  // Keep the first signed URL per path so token refreshes do not reload the inline preview.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  if (assetUrl._tag === "Success" && (loaded === null || loaded.path !== absolutePath)) {
    setLoaded({ path: absolutePath, url: assetUrl.url });
  }
  const src = loaded?.path === absolutePath ? loaded.url : null;
  const failed = src === null && assetUrl._tag === "Failure";

  const openInOverlay = () => {
    if (!threadRef) return;
    useRightPanelStore.getState().openFile(threadRef, absolutePath);
  };

  return (
    <div
      role="button"
      tabIndex={threadRef ? 0 : -1}
      aria-label={`${label} — Open larger`}
      data-rubato-segno-html-card=""
      data-html-path={absolutePath}
      onClick={openInOverlay}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openInOverlay();
      }}
      className={cn(
        "group/html-card mt-1.5 flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border/90 bg-card text-left text-card-foreground shadow-xs transition-[border-color,box-shadow]",
        "hover:border-primary/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-border/80 border-b bg-muted/45 px-2.5 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <Globe2Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span className="truncate" translate="no" title={absolutePath}>
            {label}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 font-medium text-[0.68rem] text-primary transition-colors group-hover/html-card:bg-primary/20">
          <span>Open larger</span>
          <Maximize2Icon aria-hidden="true" className="size-3" />
        </span>
      </div>
      <div className="relative h-[17rem] w-full overflow-hidden bg-background">
        {src !== null ? (
          <iframe
            src={src}
            title={label}
            // Never allow-same-origin: opaque origin isolates attached HTML from app session/storage.
            sandbox="allow-scripts allow-forms"
            loading="lazy"
            tabIndex={-1}
            className="pointer-events-none block size-full border-0"
            style={{ backgroundColor: "Canvas" }}
          />
        ) : failed ? (
          <div className="flex size-full items-center justify-center px-4 text-center text-muted-foreground text-xs">
            HTML preview unavailable
          </div>
        ) : (
          <div className="size-full animate-pulse bg-muted/40" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
