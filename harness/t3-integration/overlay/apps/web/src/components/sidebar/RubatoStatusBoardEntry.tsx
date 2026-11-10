// The status board's row at the top of the thread sidebar (status-board-edits.mjs), with how
// many agents are at work now. The count turns amber while one of them has stalled.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useBoardNow, useStatusBoard } from "../../state/rubatoStatusBoard";
import { boardCounts } from "../rubatoStatusBoardModel";
import { useBoardFolders } from "../rubatoBoardFolders";

export const STATUS_BOARD_PATH = "/board";

export function RubatoStatusBoardEntry() {
  const navigate = useNavigate();
  const onPage = useLocation({ select: (location) => location.pathname === STATUS_BOARD_PATH });
  const { environmentId, folders } = useBoardFolders();
  const board = useStatusBoard(environmentId, folders, onPage);
  const now = useBoardNow(board);
  const counts = boardCounts(board, now);
  const atWork = counts.working + counts.stalled;
  return (
    <button
      type="button"
      data-rubato-status-board-entry=""
      aria-current={onPage ? "page" : undefined}
      onClick={() => void navigate({ to: STATUS_BOARD_PATH })}
      className={cn(
        "mt-1.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground/90",
        "hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        onPage && "bg-sidebar-accent font-medium text-sidebar-foreground",
      )}
    >
      <ActivityIcon aria-hidden className={cn("size-4 shrink-0", atWork > 0 ? "text-info" : "text-sidebar-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate">Status board</span>
      {atWork > 0 ? (
        <span
          aria-label={counts.stalled > 0 ? `${atWork} at work, ${counts.stalled} stalled` : `${atWork} at work`}
          className={cn(
            "flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-[.68rem] font-semibold tabular-nums",
            counts.stalled > 0 ? "bg-warning/20 text-warning-foreground" : "bg-info/20 text-info-foreground",
          )}
        >
          {atWork}
        </span>
      ) : null}
    </button>
  );
}
