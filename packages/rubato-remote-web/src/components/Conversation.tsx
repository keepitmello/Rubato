import { Message, Messages } from "konsta/react"
import { Streamdown } from "streamdown"
import type { ConversationEntry, RegisteredHost } from "../lib/types"

const safeUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url, location.origin)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null
  } catch { return null }
}

export function Conversation({ entries }: { entries: readonly ConversationEntry[]; host?: RegisteredHost | undefined; liveSessionId?: string | undefined }) {
  return <Messages className="session-messages">{entries.map((entry) => {
    if (entry.kind !== "message") return null
    const sent = entry.role === "user"
    return <Message
      component="article"
      className={`session-message ${sent ? "session-message-sent" : "session-message-received"}`}
      key={entry.id}
      type={sent ? "sent" : "received"}
      aria-label={sent ? "내 메시지" : "Rubato 응답"}
      text={<Streamdown mode={entry.streaming ? "streaming" : "static"} parseIncompleteMarkdown={Boolean(entry.streaming)} urlTransform={(url) => safeUrl(url)} linkSafety={{ enabled: true }} controls={false}>{entry.text || "…"}</Streamdown>}
    />
  })}</Messages>
}
