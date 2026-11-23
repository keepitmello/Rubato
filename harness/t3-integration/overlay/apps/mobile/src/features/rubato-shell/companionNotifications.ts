// Rubato: where a companion's message notification goes. Tapping opens the companion's room
// (features/companions/companionNotification.ts builds the link); while that room is already
// on screen, the message shows there, so the banner stays quiet, as T3 does for its threads.
import type { NotificationBehavior } from "expo-notifications";

import { companionNotificationLink } from "../companions/companionNotification";

export const COMPANION_ROOM_ON_SCREEN: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/** Whether this notification is a message from the companion whose room is on screen. */
export function companionNotificationOnScreen(data: unknown, pathname: string | null): boolean {
  if (!pathname?.startsWith("/companions/")) return false;
  const link = companionNotificationLink(data);
  if (!link) return false;
  const [room, query] = pathname.split("?");
  const [target, targetQuery] = link.split("?");
  if (room!.replace(/\/+$/, "") !== target) return false;
  const shown = new URLSearchParams(query);
  const sent = new URLSearchParams(targetQuery);
  // A bare room route hasn't resolved its Mac yet. Once known, don't silence another Mac's room.
  return ["environmentId", "threadId"].every((key) =>
    !shown.get(key) || !sent.get(key) || shown.get(key) === sent.get(key));
}

export { companionNotificationLink };
