// A companion's face wherever the app draws one — the list in Settings › Companion, the rail, the
// room's header and the call sheet: its picture (cropped round), or the first letter of its name, or
// "?" while it has no name yet (intent companion-manage). And the one way the pages open its room,
// optionally with a draft the person finishes and sends themselves.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import {
  selectCompanion,
  useCompanionAvatar,
  useReadyEnvironmentId,
  useRubatoCompanion,
  useUiText,
} from "../../state/rubatoCompanion";

export interface FaceCompanion {
  readonly id: string;
  readonly title: string;
  readonly nameless?: boolean;
}

export function RubatoCompanionFace({
  companion,
  className,
}: {
  companion: FaceCompanion | undefined;
  className?: string;
}) {
  const url = useCompanionAvatar(companion?.id);
  if (url)
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-rubato-companion-face="picture"
        className={cn("shrink-0 select-none rounded-full object-cover object-top", className)}
      />
    );
  const letter = companion && !companion.nameless ? (Array.from(companion.title.trim())[0] ?? "?") : "?";
  return (
    <span
      aria-hidden="true"
      translate="no"
      data-rubato-companion-face="letter"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full border border-border bg-muted font-medium text-muted-foreground",
        className,
      )}
    >
      {letter}
    </span>
  );
}

/** Puts the caret at the end of the room's composer once it is on screen. */
export function focusRoomComposer(): void {
  let tries = 0;
  const go = () => {
    const editor = document.querySelector<HTMLElement>('[data-rubato-segno-chat] [contenteditable="true"]');
    if (!editor) {
      tries += 1;
      if (tries < 30) window.setTimeout(go, 100);
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  window.requestAnimationFrame(go);
}

/**
 * Opens a companion's room; with `draft`, the composer starts with it and the caret waits at its
 * end. Nothing is sent. False when the room is not in the app yet.
 */
export function useOpenCompanionRoom() {
  const navigate = useNavigate();
  const environmentId = useReadyEnvironmentId();
  return useCallback(
    async (threadId: string | null, draft?: string): Promise<boolean> => {
      if (environmentId === null || threadId === null) return false;
      if (draft !== undefined)
        useComposerDraftStore.getState().setPrompt(scopeThreadRef(environmentId, ThreadId.make(threadId)), draft);
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      focusRoomComposer();
      return true;
    },
    [environmentId, navigate],
  );
}

/**
 * The face before the companion's name in its room's header; it opens the companion's page in
 * Settings, where its picture changes.
 */
export function RubatoCompanionHeaderFace({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const companion = useRubatoCompanion().companions.find((item) => item.threadId === threadId);
  const name = useUiText(companion?.title ?? "");
  if (!companion) return null;
  return (
    <button
      type="button"
      aria-label={`${name}'s profile`}
      title={`${name}'s profile`}
      data-rubato-companion-header-face=""
      onClick={() => {
        selectCompanion(companion.id);
        void navigate({ to: "/settings/companion" });
      }}
      className="flex shrink-0 cursor-pointer items-center rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RubatoCompanionFace companion={companion} className="size-6 text-[0.7rem]" />
    </button>
  );
}
