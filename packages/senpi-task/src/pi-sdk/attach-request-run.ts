import {
  RequestRunTracker,
  createInputRecord,
  countImages,
  userMessageText,
} from "../../../../harness/rubato-pi/src/transforms/request-run-tracker.mjs"

export type RequestRunSession = {
  agent?: { state?: { messages?: unknown[] }; followUpMode?: string }
  _requestRunTracker?: RequestRunTracker
  readConversationPage?: (input?: unknown) => Promise<unknown>
  requestTimelineSnapshot?: () => unknown
  getInteractiveInput?: (message: unknown) => unknown
  [key: string]: unknown
}

/**
 * Attach Rubato RequestRunTracker + readConversationPage onto a stock AgentSession.
 * Session-owner core hooks stay out of this module.
 */
export function attachRequestRunTracker(session: RequestRunSession, now: () => number = Date.now) {
  const tracker = new RequestRunTracker({ now })
  session._requestRunTracker = tracker
  session.getInteractiveInput = (message) => tracker.getRecord(message)
  session.requestTimelineSnapshot = () => tracker.snapshot()
  session.readConversationPage = async (input = {}) => {
    if (tracker.entries.length === 0) {
      tracker.rebuildFromMessages(session.agent?.state?.messages ?? [])
    }
    return tracker.readConversationPage(input)
  }
  return { session, tracker, createInputRecord, countImages, userMessageText }
}
