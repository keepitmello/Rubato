// The undo notice as T3 v0.1.0 drew it: a small card above the sidebar footer, "Settled 2
// threads, ⌘Z to undo". T3 v0.1.11 squeezed it into the footer's utility row as a short line;
// Rubato keeps the card (sidebar-look-edits.mjs).
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";

import {
  threadUndoLabel,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

// The same sources as showThreadUndoNotice.ts, so they share its translations.
const SUMMARY = {
  Settled: msg("Settled {count, plural, one {{count} thread} other {{count} threads}}"),
  Snoozed: msg("Snoozed {count, plural, one {{count} thread} other {{count} threads}}"),
  Unpinned: msg("Unpinned {count, plural, one {{count} thread} other {{count} threads}}"),
  Archived: msg("Archived {count, plural, one {{count} thread} other {{count} threads}}"),
  Discarded: msg("Discarded {count, plural, one {{count} draft} other {{count} drafts}}"),
};

export function RubatoThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const m = useMessages();
  if (!notice) return null;
  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {m(SUMMARY[notice.action], { count: notice.count })},{" "}
        <InlineButton onClick={undoLatestThreadAction}>{threadUndoLabel(keybindings, m)}</InlineButton>
      </AlertDescription>
    </Alert>
  );
}
