// A run that ends in Segno's thread notifies like a messenger (user 55dd0da4): Segno's name, the
// start of its reply, and "Open" — in the app as a toast, outside it as a desktop notification,
// under the same settings and conditions as any thread's (ThreadNotificationCoordinator.tsx, which
// hands Segno's completions here: companion-edits.mjs). The thread holds only the person's messages
// and Segno's reply/say, so a run's last message from Segno is a reply; a run without one (the
// person's turn that Segno closed without replying) raises nothing.
import type { EnvironmentId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { getClientSettings } from "../../hooks/useSettings";
import { uiText } from "../../rubatoI18n";
import { companionForThread, rubatoCompanion, segnoNotice, selectCompanion } from "../../state/rubatoCompanion";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { RubatoSegnoIcon } from "../sidebar/RubatoSegnoIcon";
import { toastManager } from "../ui/toast";

export interface SegnoCompletion {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly runId: string | null;
  readonly mode: ClientSettings["notificationMode"];
  readonly inAppNotificationsEnabled: boolean;
  /** Whether the person has Segno's thread open: then no toast, as for any thread. */
  readonly viewing: boolean;
  readonly open: () => void;
  readonly onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}

export async function notifySegnoCompletion(input: SegnoCompletion): Promise<void> {
  const said =
    input.runId === null
      ? null
      : await rubatoCompanion
          .said(input.environmentId, input.threadId, input.runId)
          .then((answer) => answer.text)
          .catch(() => null);
  const companion = companionForThread(input.threadId);
  const notice = segnoNotice(said, companion?.title);
  if (notice === null) return;
  if (hasNotificationSound(input.mode)) {
    void playNotificationSound("completion", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (input.inAppNotificationsEnabled && focused && !input.viewing) {
    const toastId = toastManager.add({
      type: "info",
      title: notice.title,
      description: notice.body,
      data: {
        hideCopyButton: true,
        leadingIcon: <RubatoSegnoIcon className="size-4" />,
      },
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(toastId);
          if (companion) selectCompanion(companion.id);
          input.open();
        },
      },
    });
    return;
  }
  if (
    !hasDesktopNotifications(input.mode) ||
    focused ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification(uiText(notice.title), {
      body: notice.body,
      tag: `${input.environmentId}:${input.threadId}`,
      silent: true,
    });
    input.onNotification(input.environmentId, notification);
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      if (companion) selectCompanion(companion.id);
      input.open();
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
  }
}
