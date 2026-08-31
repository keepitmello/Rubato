import { useState } from "react"
import { Streamdown } from "streamdown"
import { fetchArtifactText } from "../lib/api"
import type { ConversationEntry, RegisteredHost } from "../lib/types"

const safeUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url, location.origin)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null
  } catch { return null }
}

function ToolEntry({ entry, host, liveSessionId }: { entry: Extract<ConversationEntry, { kind: "tool" }>; host?: RegisteredHost | undefined; liveSessionId?: string | undefined }) {
  const [artifact, setArtifact] = useState<string>()
  const [problem, setProblem] = useState("")
  const loadArtifact = async (open: boolean) => {
    if (!open || !entry.artifactId || artifact || !host || !liveSessionId) return
    try { setArtifact(await fetchArtifactText(host, liveSessionId, entry.artifactId)) }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : "도구 결과를 불러오지 못했어요.") }
  }
  return <details className="tool-card" onToggle={(event) => void loadArtifact(event.currentTarget.open)}>
    <summary aria-label={`${entry.name}, ${entry.status === "running" ? "실행 중" : entry.status === "failed" ? "실패" : "완료"}. 세부 내용 펼치기`}>
      <span aria-hidden="true">{entry.status === "running" ? "◌" : entry.status === "failed" ? "!" : "✓"}</span>
      <span><strong>{entry.name}</strong><span className="meta" style={{ display: "block" }}>{entry.summary}</span></span>
    </summary>
    <pre className="tool-output">{problem || [entry.output, artifact].filter(Boolean).join("\n") || (entry.artifactId ? "큰 결과를 불러오는 중…" : "표시할 출력이 없습니다.")}</pre>
  </details>
}

export function Conversation({ entries, host, liveSessionId }: { entries: readonly ConversationEntry[]; host?: RegisteredHost | undefined; liveSessionId?: string | undefined }) {
  return <>{entries.map((entry) => {
    if (entry.kind === "message") return <article className="entry" key={entry.id} aria-label={entry.role === "user" ? "내 메시지" : "Rubato 응답"}><div className={`message ${entry.role}`}><Streamdown mode={entry.streaming ? "streaming" : "static"} parseIncompleteMarkdown={Boolean(entry.streaming)} urlTransform={(url) => safeUrl(url)} linkSafety={{ enabled: true }} controls={false}>{entry.text || "…"}</Streamdown></div></article>
    if (entry.kind === "thinking") return <div className="entry thinking" key={entry.id}><details><summary>생각 과정</summary><div>{entry.text}{entry.streaming ? "…" : ""}</div></details></div>
    if (entry.kind === "tool") return <div className="entry" key={entry.id}><ToolEntry entry={entry} host={host} liveSessionId={liveSessionId} /></div>
    if (entry.kind === "image") return <figure className="entry" key={entry.id}><img src={entry.url} alt={entry.alt} /><figcaption className="meta">{entry.alt}</figcaption></figure>
    return <div className="notice" role="status" key={entry.id}>{entry.text}</div>
  })}</>
}
