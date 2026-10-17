import type { ScopedThreadRef } from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import type { KeyboardEvent, MouseEvent } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { resolveMarkdownMediaPreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

/** Where the "Open" button of a read row takes the file it read. */
export type RubatoReadOpenTarget =
  | { readonly kind: "media"; readonly path: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * The file a read row opens, from its read paths (one per line, absolute or
 * under the workspace). It opens the way a file link in a reply does: media in
 * the expanded preview, any other file in the files panel, by its workspace path
 * when it is inside the workspace and read-only by its host path when it is not.
 */
export function rubatoReadOpenTarget(
  readPaths: string | null,
  workspaceRoot: string | undefined,
): RubatoReadOpenTarget | null {
  const path = readPaths
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!path) return null;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && mediaMimeTypeFromExtension(name.slice(dot)) !== null) {
    return { kind: "media", path };
  }
  const root = workspaceRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalized = path.replaceAll("\\", "/");
  if (root && normalized.startsWith(`${root}/`)) {
    return { kind: "file", path: normalized.slice(root.length + 1) };
  }
  return { kind: "file", path };
}

/** "Open" at the end of a read row, beside its time, like "Open subagent". */
export function RubatoReadOpenButton(props: {
  readonly target: RubatoReadOpenTarget;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { target, threadRef, workspaceRoot, onImageExpand } = props;
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const preparedConnection = usePreparedConnection(threadRef.environmentId);
  const openFile = (path: string) => useRightPanelStore.getState().openFile(threadRef, path);

  const open = (event: MouseEvent) => {
    // The row itself toggles its details; the button only opens the file.
    event.stopPropagation();
    if (target.kind === "file") {
      openFile(target.path);
      return;
    }
    void resolveMarkdownMediaPreview({
      source: target.path,
      resolvedFilePath: target.path,
      cwd: workspaceRoot,
      threadRef,
      httpBaseUrl:
        preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : undefined,
      createAssetUrl,
      onOpenFile: openFile,
    }).then(
      (preview) => {
        if (preview) onImageExpand(preview);
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description:
              error instanceof Error
                ? error.message
                : "The file could not be loaded. It may have been moved or deleted.",
          }),
        );
      },
    );
  };

  return (
    <InlineButton
      aria-label={`Open ${target.path}`}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      Open
    </InlineButton>
  );
}
