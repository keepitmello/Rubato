# Notification System Design — The Complete Architecture

Notifications are the mechanism by which an application communicates with users across time, context, and attention states. A well-designed notification system treats user attention as a scarce, non-renewable resource. Every notification sent is a withdrawal from a trust account — send too many, and the user revokes permission, mutes the channel, or uninstalls entirely. This reference provides a complete framework for designing notification systems that inform without overwhelming.

---

## Notification Taxonomy

Not all notifications are equal. Each channel has distinct characteristics, appropriate use cases, and design constraints.

### Toast Notifications

Toasts are ephemeral, non-blocking messages that appear briefly and auto-dismiss. They communicate the result of an action or a low-urgency system event.

- **Duration:** 3-8 seconds. Shorter for simple confirmations ("Saved"), longer for messages with actions ("Message sent. Undo").
- **Dismissal:** Auto-dismiss by default. User can dismiss early by clicking/swiping. Pause auto-dismiss on hover (desktop) or touch-hold (mobile).
- **Blocking:** Never. Toasts must not prevent interaction with the underlying interface.
- **Use cases:** Action confirmations, non-critical status updates, undo opportunities.

### Banner / Alert Notifications

Banners are persistent, inline messages that remain visible until the user takes action or explicitly dismisses them.

- **Persistence:** Remain until dismissed or until the triggering condition resolves.
- **Positioning:** Page-level (top of viewport, full width) or inline (within a specific content area, near the relevant context).
- **Use cases:** System maintenance warnings, trial expiration, required actions, form validation summaries.

### Badge Notifications

Badges are small numeric or dot indicators overlaid on icons, typically in navigation or tab bars.

- **Persistence:** Remain until the user visits the associated section or addresses the items.
- **Information density:** A numeric badge communicates count; a dot badge communicates presence (something new exists, exact count unknown or irrelevant).
- **Use cases:** Unread message counts, pending approvals, unseen updates.

### Push Notifications

Push notifications are OS-level alerts delivered outside the application context.

- **Delivery:** Via APNs (iOS), FCM (Android), or Web Push API (browsers).
- **Persistence:** Appear in the OS notification center until opened or dismissed.
- **Permission:** Require explicit user opt-in. This permission is precious and easily revoked.
- **Use cases:** Time-sensitive messages, direct communications from other users, critical account alerts.

### In-App Notification Center

A persistent, user-accessible list of all notifications, typically accessed via a bell icon in the application header.

- **Persistence:** Permanent (or until explicitly deleted by the user).
- **Organization:** Chronological, often with time-based grouping (Today, Yesterday, This Week).
- **Use cases:** Historical record of all events, catch-up mechanism for users who missed real-time notifications.

### Email and SMS

External notifications delivered to the user's email inbox or phone via SMS.

- **Latency:** Acceptable for non-urgent, asynchronous communication.
- **Persistence:** Permanent in the user's inbox.
- **Regulatory concerns:** Must comply with CAN-SPAM, GDPR, and local regulations. Must include unsubscribe mechanism.
- **Use cases:** Account security (password resets, login alerts), digest summaries, marketing (with consent), receipts and confirmations.

---

## Urgency Framework

Every notification must be classified by urgency. This classification determines its visual treatment, channel routing, and interruptive behavior.

| Level | Color | Icon | Behavior | Sound | Examples |
|---|---|---|---|---|---|
| **Informational** | Blue or gray | Info circle | Non-interruptive. Logged to notification center only, or shown as subtle toast. | None | Feature announcements, tips, usage stats |
| **Standard** | Default (neutral) | Varies by type | Mildly interruptive. Toast with auto-dismiss. | Optional soft tone | Action confirmations, new content available |
| **Important** | Yellow or amber | Warning triangle | Moderately interruptive. Persistent banner or prominent toast. Push notification if user is away. | Short alert tone | Payment due, approaching deadline, required action |
| **Critical** | Red | Error octagon or exclamation | Highly interruptive. Modal or blocking banner. Push notification regardless of app state. | Urgent alert tone | Security breach, payment failure, data loss risk, system outage |

**The cardinal rule:** Critical urgency must be reserved for genuine emergencies. If users see red alerts for non-critical events, they learn to ignore all alerts — the "crying wolf" effect. Audit your notification urgency distribution regularly: if more than 5% of notifications are marked critical, you are almost certainly over-classifying.

---

## Toast Design

Toasts are the workhorse of in-app notifications. Their design must balance visibility with non-intrusiveness.

### Stacking Behavior

When multiple toasts fire in quick succession:

- **Maximum visible:** 3 toasts at a time. Additional toasts queue and appear as existing ones dismiss.
- **Stack direction:** Newest on top (desktop) or newest on bottom (mobile, to avoid overlap with navigation).
- **When queue exceeds 5:** Collapse into a summary toast: "3 more notifications" with a link to the notification center.

### Positioning

- **Desktop:** Top-right corner, 16-24px from viewport edges. This positions toasts near the user's natural focal area without overlapping primary content.
- **Mobile:** Bottom of screen, above the tab bar if present. Bottom positioning avoids overlap with the status bar and is reachable for dismissal via swipe.
- **RTL layouts:** Mirror to top-left (desktop).

### Anatomy

```
+----------------------------------------------+
| [Icon]  Message text here           [X Close] |
|         Optional action link                   |
+----------------------------------------------+
```

- **Icon:** Indicates type (checkmark for success, info circle for informational, warning for caution, error for failure).
- **Message:** Concise, one line if possible. Two lines maximum. Action-oriented language.
- **Action (optional):** A single text button for the most relevant follow-up action ("Undo", "View", "Retry").
- **Dismiss:** Always include an explicit close button. Do not rely solely on auto-dismiss — users with motor impairments or screen readers need a persistent target.

### React Toast Component

```jsx
import { useState, useEffect, useCallback, useRef } from 'react';

const TOAST_DURATION = {
  short: 3000,
  standard: 5000,
  long: 8000,
};

function Toast({ id, type = 'info', message, action, duration = 'standard', onDismiss }) {
  const [isExiting, setIsExiting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => onDismiss(id), 300); // Match exit animation duration
  }, [id, onDismiss]);

  useEffect(() => {
    if (isPaused) {
      clearTimeout(timerRef.current);
      return;
    }
    timerRef.current = setTimeout(dismiss, TOAST_DURATION[duration]);
    return () => clearTimeout(timerRef.current);
  }, [isPaused, duration, dismiss]);

  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ',
  };

  return (
    <div
      className={`toast toast--${type} ${isExiting ? 'toast--exiting' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <span className="toast__icon" aria-hidden="true">{icons[type]}</span>
      <div className="toast__content">
        <p className="toast__message">{message}</p>
        {action && (
          <button
            className="toast__action"
            onClick={() => { action.onClick(); dismiss(); }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        className="toast__close"
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div
      className="toast-container"
      aria-label="Notifications"
      role="region"
    >
      {toasts.slice(0, 3).map((toast) => (
        <Toast key={toast.id} {...toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
```

### ARIA Live Region

Toasts must announce themselves to screen readers via ARIA live regions:

- Use `role="status"` with `aria-live="polite"` for informational and success toasts — they should not interrupt the current screen reader announcement.
- Use `role="alert"` with `aria-live="assertive"` *only* for error or critical toasts that require immediate attention.
- Set `aria-atomic="true"` so the entire toast message is read as a unit, not just the changed portion.

### Toast Animation

- **Enter:** Slide in from the right (desktop) or up from the bottom (mobile) over 250ms with an ease-out curve. Slight vertical offset creates a natural stacking effect.
- **Exit:** Fade out over 200ms with an ease-in curve. Remaining toasts slide to fill the gap over 200ms.
- **Respect reduced motion:** When `prefers-reduced-motion` is set, replace slide animations with simple opacity fades.

---

## Banner / Alert Design

Banners communicate important information that applies to the entire page or a specific section.

### Page-Level vs. Inline

- **Page-level banners** span the full width of the viewport, typically below the top navigation. They communicate system-wide information: maintenance schedules, trial status, required account actions.
- **Inline alerts** are positioned within the content flow, adjacent to the relevant context. Form validation summaries, section-specific warnings, and contextual tips are inline alerts.

### Variants

| Variant | Color | Use Case |
|---|---|---|
| **Info** | Blue background, blue icon | Neutral information, tips, announcements |
| **Success** | Green background, check icon | Confirmation of completed action |
| **Warning** | Yellow/amber background, warning icon | Potential issue requiring attention |
| **Error** | Red background, error icon | Problem that prevents progress |

### Dismissibility

- **Dismissible** banners include a close button and disappear when dismissed. User preference should be remembered (do not show the same dismissed banner on every page load).
- **Persistent** banners have no close button and remain until the underlying condition resolves (e.g., "Your trial expires in 3 days" remains until the user subscribes or the trial ends).

---

## Push Notification UX

Push notifications are the most interruptive notification channel. They demand careful design.

### Permission Request Timing

**Never request push notification permission on the first visit.** The user has no context for why they should grant it, and a denied permission is difficult to recover from (the browser remembers the denial).

Instead, use a two-step pattern:

1. **Contextual pre-prompt:** When the user performs an action that would benefit from notifications (e.g., subscribing to updates, sending a message), show an in-app prompt explaining the value: "Want to know when someone replies? Enable notifications to get instant updates."
2. **Browser permission request:** Only after the user clicks "Yes, enable" in the in-app prompt, trigger the browser's native permission dialog.

This approach achieves permission grant rates of 50-80%, compared to 5-15% for unprompted first-visit requests.

### Rich Notifications

Modern push notifications support rich content:

- **Title:** Bold, concise. Under 50 characters.
- **Body:** Supporting detail. Under 100 characters. On Android, expandable for longer messages.
- **Image:** Large image (Android) or thumbnail (iOS). Use for content-driven notifications (new photo, product recommendation).
- **Action buttons:** Up to 2-3 buttons for quick actions without opening the app ("Reply", "Mark as Read", "Snooze").
- **Deep linking:** Tapping the notification should navigate directly to the relevant content, not the app's home screen.

### Notification Grouping

When multiple notifications of the same type arrive in rapid succession, group them:

- **Single:** "Alice sent you a message"
- **Grouped:** "3 new messages from Alice, Bob, and Carol"
- **Summary:** "12 new messages in 4 conversations"

Grouping prevents notification fatigue and respects the user's notification shade as a limited-space interface.

---

## Notification Center Design

The notification center is the persistent, on-demand history of all notifications.

### List Design

Each notification item includes:

- **Icon or avatar:** Identifies the source (user avatar, app icon, or type icon).
- **Title:** Primary information. Bolded if unread.
- **Body:** Supporting detail, truncated to 2 lines.
- **Timestamp:** Relative time ("5 minutes ago", "Yesterday"). Switch to absolute date after 7 days.
- **Read/unread indicator:** A dot or bold styling differentiates unread items.

### Time Grouping

Group notifications by time period:

- **Today** — individual items
- **Yesterday** — individual items
- **This Week** — individual items
- **Older** — grouped by week or month

### Bulk Actions

- **Mark all as read:** Essential for users returning after an absence.
- **Clear all:** Remove all notifications from the list.
- **Filter by type:** Allow users to view only specific categories (messages, mentions, system).

### Empty State

When the notification center has no items, do not show a blank list. Display:

- A friendly illustration or icon
- Text: "You're all caught up" or "No notifications yet"
- A brief explanation of what types of notifications will appear here

---

## Notification Preferences

Users must have granular control over their notification experience.

### Granular Controls

Provide per-category toggles:

```
Messages
  [x] In-app     [x] Push     [x] Email

Mentions & Replies
  [x] In-app     [x] Push     [ ] Email

Product Updates
  [x] In-app     [ ] Push     [ ] Email

Marketing & Promotions
  [ ] In-app     [ ] Push     [ ] Email
```

### Channel Selection

Allow users to choose which channels deliver each notification type. A user might want in-app toasts for new messages but not push notifications.

### Frequency Settings

For non-urgent categories, offer digest options:

- **Real-time:** Deliver immediately (default for direct messages)
- **Hourly digest:** Batch and deliver every hour
- **Daily digest:** Single daily summary (good for activity feeds, product updates)
- **Weekly digest:** Weekly summary email

### Quiet Hours

Allow users to set quiet hours during which non-critical notifications are silenced:

- **Schedule:** e.g., 10 PM to 7 AM
- **Override for critical:** Critical notifications (security alerts, emergency) bypass quiet hours
- **Timezone-aware:** Respect the user's local timezone

---

## Anti-Patterns to Avoid

### Notification Spam

Sending too many notifications too frequently. Symptoms: high mute/unsubscribe rates, app uninstalls, low notification open rates. Solution: audit notification volume per user per day. Set maximum thresholds. Implement intelligent batching.

### Crying Wolf

Marking non-critical notifications as urgent or critical. If every notification uses red styling and alert tones, users become desensitized and miss genuinely critical alerts. Solution: enforce the urgency framework. Regularly audit the distribution of urgency levels.

### No Opt-Out

Failing to provide granular notification preferences or making them difficult to find. Violates user trust and, in many jurisdictions, regulations. Solution: link to notification preferences from every notification (email unsubscribe links, in-app settings deep links).

### Dark Patterns in Permission Requests

Manipulative tactics to obtain push notification permission:

- Showing the browser permission dialog immediately on first visit
- Disguising the permission request as something else
- Making "Don't allow" difficult to find or understand
- Repeatedly prompting after the user has declined

Solution: use the contextual pre-prompt pattern described above. Accept "no" gracefully. Allow users to enable notifications later from settings when they are ready.

### Notification-Gated Content

Requiring users to enable notifications to access content or features. This is hostile UX. Notifications should always be optional. Never gate functionality behind notification permission.

### Ignoring Platform Conventions

Each platform has notification conventions:

- **iOS:** Notifications appear on lock screen and notification center. Grouped by app. Users expect summary notifications.
- **Android:** Notification channels with per-channel user control. Ongoing notifications for background tasks. Users expect notification dots on app icons.
- **Web:** Limited to title, body, icon, and actions. Users expect web push to be rare and valuable.

Respect these conventions. A notification system that feels native to the platform builds trust; one that fights the platform feels intrusive.

---

## Notification Routing Architecture

A mature notification system requires a server-side routing layer that determines which channel(s) to use for each event, based on the event's urgency, the user's preferences, and the user's current context.

### Event-to-Channel Routing Logic

```
Event occurs (e.g., "new message from Alice")
  |
  v
Check user preferences for this event category
  |
  v
Determine user's current context:
  - Is the app currently open and active? -> Prefer in-app (toast/badge)
  - Is the app open but in background?    -> Prefer push notification
  - Is the user away (offline > 5 min)?   -> Queue for push + consider email
  - Are quiet hours active?               -> Suppress non-critical, queue for later
  |
  v
Apply urgency rules:
  - Critical -> All enabled channels, bypass quiet hours
  - Important -> Push + in-app, respect quiet hours
  - Standard -> In-app only if active, push if away
  - Informational -> Notification center only, no interruption
  |
  v
Apply rate limiting:
  - Max 5 push notifications per hour per user (configurable)
  - Batch rapid-fire events into grouped notifications
  - Respect per-category frequency settings (real-time / digest)
  |
  v
Deliver to selected channels
```

### Deduplication

A single logical event should never produce duplicate notifications across channels in a way that confuses the user. If a toast is shown while the app is open, the same event should still be logged to the notification center but should not also trigger a push notification simultaneously. The notification center entry should be marked as "seen" if the user was active when the toast appeared.

### Delivery Receipts and Read Tracking

Track notification lifecycle states:

- **Created:** The event occurred and a notification was generated.
- **Delivered:** The notification reached the user's device or inbox.
- **Displayed:** The notification was rendered on screen (toast shown, push displayed).
- **Read/Opened:** The user interacted with the notification (clicked, tapped, or viewed in notification center).
- **Acted on:** The user performed the associated action (clicked the CTA, navigated to the content).
- **Dismissed:** The user explicitly dismissed without acting.

This lifecycle data powers analytics ("What percentage of push notifications are opened?") and enables smart routing ("This user ignores push notifications for this category — stop sending them").

---

## Toast CSS Implementation

A complete CSS implementation for the toast component, including stacking, positioning, variants, and animations:

```css
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  width: calc(100% - 32px);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.06);
  pointer-events: auto;
  animation: toast-enter 250ms ease-out;
  transform-origin: top right;
}

.toast--exiting {
  animation: toast-exit 200ms ease-in forwards;
}

.toast--success { border-left: 4px solid #2E7D32; }
.toast--error   { border-left: 4px solid #D32F2F; }
.toast--warning { border-left: 4px solid #ED6C02; }
.toast--info    { border-left: 4px solid #0288D1; }

.toast__icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}

.toast--success .toast__icon { color: #2E7D32; }
.toast--error .toast__icon   { color: #D32F2F; }
.toast--warning .toast__icon { color: #ED6C02; }
.toast--info .toast__icon    { color: #0288D1; }

.toast__content {
  flex: 1;
  min-width: 0;
}

.toast__message {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: #1a1a1a;
}

.toast__action {
  display: inline-block;
  margin-top: 4px;
  padding: 0;
  background: none;
  border: none;
  font-size: 14px;
  font-weight: 600;
  color: #1976D2;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.toast__action:hover {
  color: #1565C0;
}

.toast__close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 4px;
  color: #757575;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 150ms ease;
}

.toast__close:hover {
  background-color: #f5f5f5;
  color: #424242;
}

@keyframes toast-enter {
  from {
    opacity: 0;
    transform: translateX(100%) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

@keyframes toast-exit {
  from {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateX(100%) scale(0.95);
  }
}

/* Mobile positioning: bottom of screen */
@media (max-width: 640px) {
  .toast-container {
    top: auto;
    bottom: 16px;
    right: 16px;
    left: 16px;
    max-width: none;
    width: auto;
  }

  .toast {
    animation-name: toast-enter-mobile;
  }

  .toast--exiting {
    animation-name: toast-exit-mobile;
  }

  @keyframes toast-enter-mobile {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes toast-exit-mobile {
    from {
      opacity: 1;
      transform: translateY(0);
    }
    to {
      opacity: 0;
      transform: translateY(100%);
    }
  }
}

/* Respect reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation-duration: 0ms;
  }

  .toast--exiting {
    animation: fade-out 150ms ease-in forwards;
  }

  @keyframes fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
}
```

---

## Measuring Notification Effectiveness

A notification system that is not measured cannot be improved. Track these metrics to understand whether your notifications are helping or harming the user experience.

### Key Metrics

- **Open rate:** Percentage of delivered notifications that users open or interact with. Target varies by channel: push notifications should aim for 10-25% open rate; in-app notifications should aim for 40-60%.
- **Click-through rate (CTR):** Percentage of opened notifications where the user clicked the CTA. Indicates whether the notification content was relevant and actionable.
- **Dismissal rate:** Percentage of notifications explicitly dismissed without interaction. A high dismissal rate for a category suggests the content is not valuable to users.
- **Opt-out rate:** Percentage of users who disable a notification category per month. Rising opt-out rates signal that a category is over-sending or under-delivering value.
- **Time to action:** Duration between notification delivery and user action. Shorter times indicate higher relevance and urgency alignment.
- **Uninstall correlation:** Whether notification frequency or type correlates with app uninstalls. This is the ultimate failure metric — notifications are driving users away.

### Experimentation

Treat notification frequency and content as product variables that deserve A/B testing:

- Test different sending frequencies for the same event type.
- Test different copy and CTAs within the same notification type.
- Test different channels for the same event (push vs. email vs. in-app).
- Test grouping strategies (individual vs. batched vs. digest).

Run these experiments with care: notification experiments affect the user's broader relationship with the product, not just a single screen. Measure long-term retention and satisfaction alongside immediate engagement metrics.

### The Notification Health Dashboard

Build a dashboard that surfaces:

- Total notifications sent per user per day (trending over time)
- Per-category opt-out rates
- Push notification permission grant rate
- Open rates by channel and urgency level
- Correlation between notification volume and user retention (cohort analysis)

Review this dashboard weekly. It provides an early warning system for notification fatigue before users escalate to uninstalling.

---

## Notification Copy Guidelines

The words in a notification determine whether it is read or dismissed. Notification copy operates under extreme constraints: tiny screen real estate, a distracted user, and milliseconds of attention. Every word must earn its place.

### Title Rules

- **Lead with the who or what, not the action.** "Alice commented on your post" (who first) is better than "New comment on your post" (action first). People scan for names and recognizable context.
- **Keep under 50 characters.** Push notification titles are truncated on most platforms beyond this length. Test on real devices.
- **Avoid the app name.** The notification already shows the app icon. Using the title to repeat the app name wastes precious space.
- **Be specific.** "Your order shipped" is good. "Update from Store" is vague and dismissable.

### Body Rules

- **One sentence.** Two at most. The body supplements the title; it does not replace it.
- **Include the actionable detail.** "Your package arrives Thursday, March 12" gives the user what they need without opening the app. "Tap to see details" does not.
- **Avoid filler phrases.** "Hi there! Just wanted to let you know that..." wastes half the visible text on nothing. Start with the information.

### Action Button Labels

- **Use verbs.** "Reply", "View", "Approve" — direct, clear, unambiguous.
- **Match the action to the urgency.** A critical security notification should have "Secure Account" not "Learn More."
- **Maximum two action buttons.** More than two creates choice paralysis in a format designed for split-second decisions.

### Notification Message Examples

| Bad | Good | Why |
|---|---|---|
| "You have a new message" | "Alice: Hey, are you free for lunch?" | Shows the sender and content preview. The user can decide whether to act without opening the app. |
| "Action required" | "Please verify your email to continue" | Explains what the user needs to do, not just that something is needed. |
| "Your order update" | "Your AirPods shipped — arrives Thursday" | Specific product and delivery date. The user gets value from the notification itself. |
| "New activity in your account" | "3 new comments on 'Project Roadmap'" | Quantified, specific, references content the user recognizes. |
| "Don't miss out!" | "Sarah invited you to collaborate on 'Q2 Plans'" | Real information vs. manipulative urgency. |

---

## Accessibility in Notification Systems

Notifications are inherently dynamic content, which makes accessibility a particular challenge. Content that appears and disappears on its own timeline must be announced to assistive technology and must not create barriers for users with motor, cognitive, or visual impairments.

### Screen Reader Announcements

- **Toasts (informational/success):** Use `role="status"` with `aria-live="polite"`. The screen reader will announce the toast after completing its current utterance, without interrupting.
- **Toasts (error/critical):** Use `role="alert"` with `aria-live="assertive"`. The screen reader will interrupt immediately to announce the error. Reserve this for genuine errors — overusing assertive announcements is the accessibility equivalent of the "crying wolf" anti-pattern.
- **Notification badges:** Update the accessible label on the bell icon dynamically: `aria-label="Notifications, 3 unread"`. When the count changes, the screen reader should announce the new count if the user is focused on or near the bell icon.

### Auto-Dismiss Timing

Toast notifications that auto-dismiss create a problem for users who need more time to read. Solutions:

- **Pause on focus.** If the toast receives keyboard focus, pause the auto-dismiss timer. Resume when focus leaves.
- **Pause on hover.** Desktop users who hover over a toast are reading it — do not dismiss it from under their cursor.
- **Respect `prefers-reduced-motion`.** If the user has requested reduced motion, extend auto-dismiss timers by 50% to compensate for the absence of enter/exit animations that normally draw attention to the toast.
- **Provide a persistent alternative.** Every toast should also be logged to the notification center, where users can review it at their own pace.

### Keyboard Navigation

- **Toasts must be focusable** if they contain interactive elements (action buttons, dismiss). Use a focus-management strategy where the most recent toast is reachable via a keyboard shortcut or tab sequence.
- **Notification center** must be fully navigable by keyboard. Each notification item should be focusable, and its action buttons should be reachable via Tab.
- **Toast dismiss** must work via both the close button (mouse/touch) and the Escape key (keyboard).

### Cognitive Accessibility

- **Do not use notifications as the only way to communicate critical information.** If a form has a validation error, show the error inline near the field in addition to any toast. Users with attention or memory difficulties may miss a transient notification.
- **Avoid notification sounds that overlap with screen reader speech.** If the notification system plays audio cues, ensure they are brief (under 0.5 seconds) and do not conflict with TTS output.
- **Provide notification preferences that include a "minimal" mode** — a setting that suppresses all non-critical notifications for users who find frequent interruptions overwhelming.
