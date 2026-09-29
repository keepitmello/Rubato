import { Box, Markdown, Spacer, Text, getMarkdownTheme } from "./host-sdk.mjs";
import { senderTitle } from "./message.mjs";

export const MAX_HEADER_TITLE = 120;

/** The header line of a received message: `📨 From <title>`. */
export function sessionMessageHeader(details) {
  const title = senderTitle(details?.from);
  return `📨 From ${title.length > MAX_HEADER_TITLE ? `${title.slice(0, MAX_HEADER_TITLE - 1)}…` : title}`;
}

/**
 * Terminal renderer for `rubato-session-message`: the sender's header and the text they wrote, in
 * the custom-message colors, so it reads apart from a user bubble. It renders `details`, never the
 * model envelope in `content`; a message without usable details falls back to stock rendering.
 */
export function renderSessionMessage(message, options, theme) {
  const details = message?.details;
  if (!details || typeof details.text !== "string" || !details.from) return undefined;
  const box = new Box(options?.outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(sessionMessageHeader(details))), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(details.text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
  return box;
}
