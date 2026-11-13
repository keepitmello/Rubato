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

const pathOnly = (path: string): string => path.split("?")[0]!.replace(/\/+$/, "");

/** Whether this notification is a message from the companion whose room is on screen. */
export function companionNotificationOnScreen(data: unknown, pathname: string | null): boolean {
  const link = companionNotificationLink(data);
  return link !== null && pathname !== null && pathOnly(link) === pathOnly(pathname);
}

export { companionNotificationLink };
