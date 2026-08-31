import { Message, Messages } from "konsta/react"
import { Streamdown } from "streamdown"
import { useState } from "react"
import type { RequestTimelineSnapshot } from "@rubato/remote-protocol"
import type { ConversationEntry, RegisteredHost } from "../lib/types"
import { visibleConversationItems } from "../lib/request-timeline"
import { AppIcon } from "./Icon"
import { Sheet } from "./Shell"

type MessageEntry = Extract<ConversationEntry, { kind: "message" }>

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

function MessageBubble({ entry }: { entry: MessageEntry }) {
  const sent = entry.role === "user"
  const time = messageTime(entry.at)
  return <div className={`message-row ${sent ? "message-row-sent" : "message-row-received"}`}>
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
}

export function Conversation({
  entries,
  working = false,
  timeline,
}: {
  entries: readonly ConversationEntry[]
  working?: boolean
  timeline?: RequestTimelineSnapshot
  host?: RegisteredHost | undefined
  liveSessionId?: string | undefined
}) {
  const items = visibleConversationItems(entries, {
    working,
    ...(timeline ? { timeline } : {}),
    ...(timeline?.activeRequestRunId ? { activeRequestRunId: timeline.activeRequestRunId } : {}),
  })
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const openItem = items.find((item) => item.kind === "collapsed-progress" && item.runId === openRunId)

  return <>
    <Messages className="session-messages" aria-label="세션 대화">
      {items.map((item) => {
        if (item.kind === "collapsed-progress") {
          return <div className="work-collapse-row" key={`collapse-${item.runId}`}>
            <button type="button" className="work-collapse-control" aria-label="작업 과정" onClick={() => setOpenRunId(item.runId)}>
              <span>작업 과정</span>
              <AppIcon name="chevron-right" size={17} />
            </button>
          </div>
        }
        return <MessageBubble key={item.entry.id} entry={item.entry} />
      })}
    </Messages>
    {openItem?.kind === "collapsed-progress" ? <Sheet title="작업 과정" onClose={() => setOpenRunId(null)}>
      <Messages className="session-messages work-log-messages" aria-label="접힌 작업 과정">
        {openItem.entries.map((entry) => <MessageBubble key={entry.id} entry={entry} />)}
      </Messages>
    </Sheet> : null}
  </>
}
