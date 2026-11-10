// The only parts of the status board and the Agents panel that change every second: how long ago
// something last moved, and how long it has run. Each is its own small component on the shared
// one-second clock, so the cards around it re-render only when the board or a state changes.
import { type StatusBoard, useBoardNow } from "../state/rubatoStatusBoard";
import { formatAgo } from "./rubatoLiveness";
import { formatSpan } from "./rubatoStatusBoardModel";

/** "12s ago" ("12초 전"), ticking. */
export function BoardAgo({ at, board }: { at: number | null; board: StatusBoard | null }) {
  const now = useBoardNow(board);
  return <>{formatAgo(at, now)}</>;
}

/** "3m", "2h 07m", "30d 4h" since `from`, ticking until `to` is set. */
export function BoardSpan({ from, to, board }: { from: number | null; to: number | null; board: StatusBoard | null }) {
  const now = useBoardNow(board, to === null ? 1_000 : 3_600_000);
  return <>{formatSpan(from, to ?? now)}</>;
}
