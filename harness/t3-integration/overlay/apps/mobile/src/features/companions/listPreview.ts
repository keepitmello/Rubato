import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { DateTime } from "effect";
import { buildThreadFeed } from "../../lib/threadActivity";
import { feedRoomPreview } from "./roomModel";

/** A row needs the newest displayable message, not activities or a retained feed per room.
 * Feed order can differ from clock order. Break ties from the end, just like feedRoomPreview. */
export function listPreview(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  let latest: ReturnType<typeof feedRoomPreview> = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const { item } = row;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (latest && DateTime.toEpochMillis(item.startedAt ?? item.updatedAt) <= latest.at) continue;
    // A question elsewhere in the feed may absorb this answer. Let the full feed decide.
    if (item.type === "user_message" && item.messageId.startsWith("async-answer:")) {
      return feedRoomPreview(buildThreadFeed(rows));
    }
    latest = feedRoomPreview(buildThreadFeed([row])) ?? latest;
  }
  return latest;
}
