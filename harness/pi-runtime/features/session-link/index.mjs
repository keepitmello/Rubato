import { installSessionLink } from "./extension.mjs";

export const SESSION_LINK_FACTORY_NAME = "session-link";

/** `sessionLink` is the engine's handle (pi-server session-link.mjs); absent outside the engine. */
export function createSessionLinkFactories({ sessionLink } = {}) {
  return [{ name: SESSION_LINK_FACTORY_NAME, factory: (pi) => installSessionLink(pi, { sessionLink }) }];
}

export { installSessionLink } from "./extension.mjs";
export { DELIVER_REQUEST, SESSION_MESSAGE_TYPE, buildEnvelope, buildSessionMessage, parseDelivery } from "./message.mjs";
export { renderSessionMessage, sessionMessageHeader } from "./render.mjs";
export { SESSION_TOOL_NAMES, createSessionTools } from "./tools.mjs";
export { CACHE_SESSION_KEYS, SIDE_CHAT_ENTRY, SIDE_CHAT_NOTICE, SIDE_CHAT_NOTICE_TEXT, setCacheSessionKey, sideChatEntries, sideChatParent, trackSideChatCache } from "./side-chat.mjs";
export default createSessionLinkFactories;
