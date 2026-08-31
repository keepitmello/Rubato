import { Message, Messages } from "konsta/react"
import { Streamdown } from "streamdown"
import type { ConversationEntry, RegisteredHost } from "../lib/types"
import { AppIcon } from "./Icon"

const safeUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url, location.origin)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

function messageTime(value?: string): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(parsed)
}

export function Conversation({ entries }: {
  entries: readonly ConversationEntry[]
  host?: RegisteredHost | undefined
  liveSessionId?: string | undefined
}) {
  const messages = entries.filter((entry): entry is Extract<ConversationEntry, { kind: "message" }> => entry.kind === "message")

  return <Messages className="session-messages" aria-label="세션 대화">
    {messages.map((entry) => {
      const sent = entry.role === "user"
      const time = messageTime(entry.at)
      return <div className={`message-row ${sent ? "message-row-sent" : "message-row-received"}`} key={entry.id}>
        {!sent ? <div className="assistant-mark" aria-hidden="true"><AppIcon name="spark" size={15} /></div> : null}
        <div className="message-stack">
          <Message
            component="article"
            className={`session-message ${sent ? "session-message-sent" : "session-message-received"}`}
            type={sent ? "sent" : "received"}
            aria-label={sent ? "내 메시지" : "Rubato 응답"}
            aria-busy={entry.streaming || undefined}
            text={<Streamdown
              mode={entry.streaming ? "streaming" : "static"}
              parseIncompleteMarkdown={Boolean(entry.streaming)}
              urlTransform={(url) => safeUrl(url)}
              linkSafety={{ enabled: true }}
              controls={false}
            >{entry.text || "…"}</Streamdown>}
          />
          <div className={`message-caption ${sent ? "message-caption-sent" : ""}`}>
            {entry.streaming ? <span className="streaming-label"><span className="streaming-dot" />작업 중</span> : null}
            {time ? <time dateTime={entry.at}>{time}</time> : null}
          </div>
        </div>
      </div>
    })}
  </Messages>
}
