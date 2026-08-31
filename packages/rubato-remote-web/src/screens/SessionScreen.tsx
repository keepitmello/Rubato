import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import type { EventEnvelope, InteractiveCommandDescriptor, JsonValue, RemoteActionPayloadMap } from "@rubato/remote-protocol"
import { Conversation } from "../components/Conversation"
import { Sheet, Shell, StateBanner } from "../components/Shell"
import { applyConversationSnapshot, DeltaBatcher, reduceConversation } from "../lib/conversation"
import { fetchOlderMessages, fetchSnapshot, fixtureMode, sendAction, SessionStream, uploadImage } from "../lib/api"
import { fixtureHost } from "../lib/fixtures"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import type { ConversationEntry, ConversationState, ImageAttachment, UiRequest } from "../lib/types"

const ArtifactBrowser = lazy(() => import("../components/ArtifactBrowser"))
const EmergencyTerminal = lazy(() => import("../components/EmergencyTerminal"))
type Panel = "controls" | "commands" | "model" | "compact" | "tree" | "team" | "artifacts" | "terminal" | null

type InputAction = "input.submit" | "input.steer" | "input.followUp"

function humanThinking(value?: string): string {
  return value === "low" ? "낮은 추론" : value === "medium" ? "보통 추론" : value === "high" ? "높은 추론" : "기본 추론"
}

const supportedNativeCommands = new Set(["abort", "compact", "reload"])
const remotelyAvailable = (command: InteractiveCommandDescriptor): boolean => command.remoteMode !== "native-action" || supportedNativeCommands.has(command.name)

export function SessionScreen({ hostId, liveSessionId }: { hostId: string; liveSessionId: string }) {
  const storedHosts = useAppStore((state) => state.hosts)
  const preferences = useAppStore((state) => state.preferences)
  const queryClient = useQueryClient()
  const host = storedHosts.find((item) => item.hostId === hostId) ?? (fixtureMode ? { ...fixtureHost, hostId } : undefined)
  const snapshot = useQuery({ queryKey: ["snapshot", hostId, liveSessionId], queryFn: () => fetchSnapshot(host!, liveSessionId), enabled: Boolean(host) })
  const [conversation, setConversation] = useState<ConversationState>({ entries: [], lastSeq: 0, requiresSnapshot: false, snapshotInstalled: false, recoveryVersion: 0, bufferedEvents: [] })
  const conversationRef = useRef(conversation)
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">(navigator.onLine ? "connecting" : "offline")
  const [panel, setPanel] = useState<Panel>(null)
  const [draft, setDraft] = useState("")
  const [delivery, setDelivery] = useState<"input.steer" | "input.followUp">("input.steer")
  const [attachments, setAttachments] = useState<readonly ImageAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uiInput, setUiInput] = useState("")
  const [actionError, setActionError] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [olderLoading, setOlderLoading] = useState(false)
  const [hasOlder, setHasOlder] = useState(true)
  const composing = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const sheetOpener = useRef<HTMLElement | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  useEffect(() => { conversationRef.current = conversation }, [conversation])
  useEffect(() => {
    if (!snapshot.data) return
    const params = new URLSearchParams(location.search)
    const entries = params.get("state") === "empty" ? [] : params.get("state") === "partial" ? [...snapshot.data.entries, { id: "partial", kind: "message", role: "assistant", text: "계속 확인하고 있", streaming: true } satisfies ConversationEntry] : snapshot.data.entries
    const fixtureRequest: UiRequest | undefined = params.get("ui") === "confirm" ? { requestId: "fixture-ui-request", kind: "confirm", title: "이 변경을 적용할까요?", message: "현재 작업 파일에 접근성 수정을 적용합니다." } : undefined
    setConversation((state) => applyConversationSnapshot({ ...snapshot.data, entries: entries.slice(-100), ...((fixtureRequest ?? snapshot.data.uiRequest) ? { uiRequest: (fixtureRequest ?? snapshot.data.uiRequest)! } : {}) }, state))
  }, [snapshot.dataUpdatedAt])
  useEffect(() => {
    if (!conversation.requiresSnapshot || !host) return
    void queryClient.invalidateQueries({ queryKey: ["snapshot", hostId, liveSessionId], exact: true, refetchType: "none" })
      .then(() => snapshot.refetch())
      .catch(() => undefined)
  }, [conversation.requiresSnapshot, conversation.recoveryVersion, host, hostId, liveSessionId, queryClient])
  useEffect(() => {
    const field = composer.current
    if (!field) return
    field.style.height = "auto"
    const height = Math.min(field.scrollHeight, 120)
    field.style.height = `${Math.max(46, height)}px`
    field.style.overflowY = field.scrollHeight > 120 ? "auto" : "hidden"
  }, [draft])

  const batcher = useMemo(() => new DeltaBatcher((events) => setConversation((state) => events.reduce(reduceConversation, state))), [])
  useEffect(() => {
    if (!host) return
    const stream = new SessionStream(host, liveSessionId, () => conversationRef.current.lastSeq, (event: EventEnvelope) => batcher.push(event), setConnection)
    stream.start()
    return () => { stream.stop(); batcher.dispose() }
  }, [batcher, host, liveSessionId])
  useEffect(() => {
    if (nearBottom.current) requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }))
  }, [conversation.entries])

  const action = useMutation({
    mutationFn: async ({ type, text, imageIds }: { type: InputAction; text: string; imageIds: readonly string[] }) => {
      if (!host) throw new Error("이 호스트를 찾지 못했어요.")
      if (type === "input.steer") return sendAction(host, liveSessionId, "input.steer", { text, imageIds }, snapshot.data?.revision)
      if (type === "input.followUp") return sendAction(host, liveSessionId, "input.followUp", { text, imageIds }, snapshot.data?.revision)
      return sendAction(host, liveSessionId, "input.submit", { text, imageIds, delivery: "auto" }, snapshot.data?.revision)
    },
    onSuccess: (_value, variables) => {
      setDraft("")
      setActionError("")
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl)
      setAttachments([])
      setConversation((state) => ({ ...state, entries: [...state.entries, { id: crypto.randomUUID(), kind: "message", role: "user", text: variables.text || `이미지 ${variables.imageIds.length}개` }, ...(fixtureMode ? [{ id: crypto.randomUUID(), kind: "message" as const, role: "assistant" as const, text: variables.type === "input.followUp" ? "다음 차례에 처리하도록 추가했습니다…" : "요청을 받아 작업을 시작했습니다…", streaming: true }] : [])] }))
      setAnnouncement(variables.type === "input.followUp" ? "다음 차례에 처리할 요청을 보냈습니다." : variables.type === "input.steer" ? "즉시 반영할 지시를 보냈습니다." : "메시지를 보냈습니다.")
    },
    onError: (cause) => setActionError(cause instanceof Error ? cause.message : "메시지를 보내지 못했어요."),
  })
  const summary = snapshot.data?.summary
  const working = summary?.execution === "working" || new URLSearchParams(location.search).get("state") === "working"
  const submit = () => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || action.isPending || connection === "offline") return
    action.mutate({ type: working ? delivery : "input.submit", text, imageIds: attachments.map((attachment) => attachment.imageId) })
  }
  const attachImage = async (file?: File) => {
    if (!host || !file) return
    setUploading(true); setActionError("")
    try { const attachment = await uploadImage(host, liveSessionId, file); setAttachments((current) => [...current, attachment]) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "이미지를 추가하지 못했어요.") }
    finally { setUploading(false); if (imageInput.current) imageInput.current.value = "" }
  }
  const respondToUi = async (request: UiRequest, value: JsonValue) => {
    if (!host) return
    try {
      await sendAction(host, liveSessionId, "ui.respond", { requestId: request.requestId, value }, snapshot.data?.revision)
      setConversation((state) => ({ ...state, uiRequest: undefined }))
      setUiInput(""); setAnnouncement("응답을 보냈습니다.")
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "응답을 보내지 못했어요.") }
  }
  const loadOlder = async () => {
    if (!host || olderLoading) return
    setOlderLoading(true)
    try {
      const first = conversation.entries[0]
      const older = await fetchOlderMessages(host, liveSessionId, first?.id)
      setConversation((state) => ({ ...state, entries: [...older, ...state.entries].slice(-1_000) }))
      if (older.length < 100) setHasOlder(false)
    } finally { setOlderLoading(false) }
  }
  const fire = async <T extends keyof RemoteActionPayloadMap>(type: T, payload: RemoteActionPayloadMap[T], message: string) => {
    if (!host) return
    try { await sendAction(host, liveSessionId, type, payload, snapshot.data?.revision); setPanel(null); setAnnouncement(message) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "요청을 마치지 못했어요.") }
  }
  const runCommand = (command: InteractiveCommandDescriptor) => {
    if (command.remoteMode === "direct") {
      setPanel(null)
      action.mutate({ type: "input.submit", text: `/${command.name}`, imageIds: [] })
      return
    }
    if (command.remoteMode === "terminal-only") {
      setAnnouncement(`/${command.name} 명령은 비상 터미널에서 실행해야 합니다.`)
      setPanel("terminal")
      return
    }
    if (command.name === "compact") { setPanel("compact"); return }
    if (command.name === "reload") { void fire("session.reload", {}, "세션을 다시 불러왔습니다."); return }
    if (command.name === "abort") void fire("agent.abort", {}, "작업을 중단했습니다.")
  }
  const availableCommands = snapshot.data?.commands.filter(remotelyAvailable) ?? []

  if (!host) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>연결된 Mac을 찾지 못했어요.</strong><p>설정에서 이 Mac을 다시 연결하세요.</p><button className="secondary" onClick={() => navigate("/settings")}>설정 열기</button></div></main></Shell>
  if (snapshot.isLoading) return <Shell title="세션" back="/"><main className="content"><div className="skeleton" /><div className="skeleton" /></main></Shell>
  if (snapshot.isError || !summary) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>대화를 불러오지 못했어요.</strong><p>Mac의 연결 상태를 확인한 뒤 다시 시도하세요.</p><button className="secondary" onClick={() => void snapshot.refetch()}>다시 시도</button></div></main></Shell>

  return <Shell title={summary.title} back="/" action={<button className="icon-button" aria-label="세션 제어 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}>•••</button>}>
    {(connection === "offline" || new URLSearchParams(location.search).get("state") === "offline") ? <StateBanner>연결이 끊겼어요. 대화는 그대로 두고 다시 연결하고 있습니다.</StateBanner> : connection === "connecting" ? <StateBanner>Mac에 다시 연결하는 중…</StateBanner> : null}
    {conversation.requiresSnapshot ? <StateBanner kind="error">일부 업데이트를 놓쳤어요. 현재 대화를 다시 불러옵니다. <button className="text-button" onClick={() => void snapshot.refetch()}>다시 시도</button></StateBanner> : null}
    <div className="session-head">
      <div className="row spread"><span className="status"><span className={`status-dot ${working ? "working" : ""}`} />{working ? "작업 중" : "대기"}</span><span className="meta path">{host.displayName} · {summary.cwd.replace(/^\/Users\/[^/]+/, "~")}</span></div>
      <div className="meta" style={{ marginTop: 8 }}><span className="chip">{summary.model.label}</span><span className="chip">{humanThinking(summary.model.thinkingLevel)}</span>{summary.context.remainingPercent !== undefined ? <span className="chip">문맥 {summary.context.remainingPercent}% 남음</span> : null}{summary.background.activeCount > 0 ? <button className="chip" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("team") }}>하위 작업 {summary.background.activeCount}개</button> : null}</div>
    </div>
    {conversation.uiRequest ? <section className="surface ui-request" aria-labelledby="ui-request-title">
      <h2 id="ui-request-title" style={{ margin: 0, fontSize: "1rem" }}>{conversation.uiRequest.title}</h2>{conversation.uiRequest.message ? <p className="meta">{conversation.uiRequest.message}</p> : null}
      {conversation.uiRequest.kind === "select" ? <div className="ui-options">{conversation.uiRequest.options?.map((option) => <button className="secondary" key={option.value} onClick={() => void respondToUi(conversation.uiRequest!, option.value)}>{option.label}</button>)}</div> : null}
      {conversation.uiRequest.kind === "confirm" ? <div className="sheet-actions"><button className="secondary" onClick={() => void respondToUi(conversation.uiRequest!, false)}>아니요</button><button className="primary" onClick={() => void respondToUi(conversation.uiRequest!, true)}>적용</button></div> : null}
      {conversation.uiRequest.kind === "input" ? <div className="ui-options"><label className="field"><span className="field-label">응답</span><input className="input" value={uiInput} placeholder={conversation.uiRequest.placeholder} onChange={(event) => setUiInput(event.target.value)} /></label><button className="primary" disabled={!uiInput.trim()} onClick={() => void respondToUi(conversation.uiRequest!, uiInput.trim())}>응답 보내기</button></div> : null}
    </section> : null}
    <main ref={scroll} className="conversation" onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120 }}>
      {hasOlder && conversation.entries.length > 0 ? <div style={{ textAlign: "center" }}><button className="text-button" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "불러오는 중…" : "이전 대화 보기"}</button></div> : null}
      {conversation.entries.length === 0 ? <div className="surface empty"><div className="empty-mark" aria-hidden="true">R</div><strong>무엇을 할지 알려주세요.</strong><p className="meta">메시지를 보내면 이 Mac의 같은 Rubato 세션에서 작업을 시작합니다.</p></div> : <Conversation entries={conversation.entries} host={host} liveSessionId={liveSessionId} />}
    </main>
    {actionError ? <div className="state-banner error" role="alert">{actionError} <button className="text-button" onClick={submit}>다시 보내기</button></div> : null}
    <div className="composer-shell">
      {working ? <div className="delivery-toggle" aria-label="작업 중 메시지 처리"><button aria-pressed={delivery === "input.steer"} onClick={() => setDelivery("input.steer")}>즉시 반영</button><button aria-pressed={delivery === "input.followUp"} onClick={() => setDelivery("input.followUp")}>다음 차례</button></div> : null}
      {attachments.length > 0 ? <div className="attachment-row" aria-label="첨부 이미지">{attachments.map((attachment) => <div className="attachment" key={attachment.imageId}><img src={attachment.previewUrl} alt="" /><span>{attachment.name}</span><button className="icon-button" aria-label={`${attachment.name} 제거`} onClick={() => setAttachments((current) => current.filter((item) => item.imageId !== attachment.imageId))}>×</button></div>)}</div> : null}
      <div className="composer">
      <input ref={imageInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" aria-label="이미지 파일 선택" onChange={(event) => void attachImage(event.target.files?.[0])} />
      <button className="composer-menu" aria-label="도구와 명령 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}>＋</button>
      <label className="sr-only" htmlFor="message">메시지</label><textarea ref={composer} id="message" rows={1} value={draft} disabled={connection === "offline"} placeholder={connection === "offline" ? "연결되면 보낼 수 있어요" : working ? "추가 지시 보내기" : "메시지"} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit() } }} />
      {working && !draft.trim() && attachments.length === 0 ? <button className="abort" onClick={() => void fire("agent.abort", {}, "작업을 중단했습니다.")}>중단</button> : <button className="send" aria-label={working ? delivery === "input.followUp" ? "다음 차례에 보내기" : "즉시 반영할 지시 보내기" : "메시지 보내기"} disabled={(!draft.trim() && attachments.length === 0) || action.isPending || uploading || connection === "offline"} onClick={submit}>↑</button>}
    </div></div>
    <div className="live-region" aria-live="polite">{announcement}</div>

    {panel === "controls" ? <Sheet returnFocus={sheetOpener.current} title="세션 도구" onClose={() => setPanel(null)}><div className="control-grid"><button className="control" onClick={() => setPanel("commands")}>스킬과 명령</button><button className="control" onClick={() => { setPanel(null); requestAnimationFrame(() => imageInput.current?.click()) }}>이미지 추가</button><button className="control" onClick={() => setPanel("model")}>모델</button><button className="control" onClick={() => setPanel("compact")}>대화 정리</button><button className="control" onClick={() => setPanel("tree")}>대화 가지</button><button className="control" onClick={() => setPanel("team")}>하위 작업</button><button className="control" onClick={() => setPanel("artifacts")}>파일과 변경점</button><button className="control" onClick={() => setPanel("terminal")}>비상 터미널</button><button className="control" onClick={() => void fire("session.reload", {}, "세션을 다시 불러왔습니다.")}>다시 불러오기</button><button className="control" onClick={() => setPanel(null)}>닫기</button></div></Sheet> : null}
    {panel === "commands" ? <Sheet returnFocus={sheetOpener.current} title="스킬과 명령" onClose={() => setPanel(null)}><p className="meta">이 세션에서 사용할 수 있는 명령만 표시합니다.</p><div className="surface">{availableCommands.length === 0 ? <p className="meta">원격에서 사용할 수 있는 명령이 없습니다.</p> : availableCommands.map((command) => <button className="choice" key={command.name} onClick={() => runCommand(command)}><strong>/{command.name}</strong><div className="meta">{command.description}{command.remoteMode === "terminal-only" ? " · 비상 터미널 필요" : ""}</div></button>)}</div></Sheet> : null}
    {panel === "model" ? <Sheet returnFocus={sheetOpener.current} title="모델과 추론" onClose={() => setPanel(null)}><div className="surface"><button className="choice" onClick={() => void fire("model.set", { provider: "openai", modelId: "gpt-5.6" }, "GPT-5.6으로 바꿨습니다.")}><strong>GPT-5.6</strong><div className="meta">현재 선택</div></button><button className="choice" onClick={() => void fire("model.set", { provider: "anthropic", modelId: "claude" }, "Claude로 바꿨습니다.")}><strong>Claude</strong><div className="meta">긴 글과 코드 작업</div></button></div><div className="section-title">추론 강도</div><div className="control-grid">{[["low","낮음"],["medium","보통"],["high","높음"]] .map(([value,label]) => <button className="control" key={value} onClick={() => void fire("thinking.set", { level: value }, `${label}으로 바꿨습니다.`)}>{label}</button>)}</div></Sheet> : null}
    {panel === "compact" ? <Sheet returnFocus={sheetOpener.current} title="대화 정리" onClose={() => setPanel(null)}><p>오래된 대화를 요약해 문맥 공간을 확보합니다. 현재 작업과 파일은 유지됩니다.</p><label className="field"><span className="field-label">남길 내용 (선택)</span><input className="input" id="compact-instructions" placeholder="예: 접근성 결정은 모두 유지" /></label><div className="sheet-actions"><button className="secondary" onClick={() => setPanel(null)}>취소</button><button className="primary" onClick={() => { const instructions = (document.getElementById("compact-instructions") as HTMLInputElement).value; void fire("session.compact", instructions ? { instructions } : {}, "대화 정리를 시작했습니다.") }}>정리 시작</button></div></Sheet> : null}
    {panel === "tree" ? <Sheet returnFocus={sheetOpener.current} title="대화 가지" onClose={() => setPanel(null)}><div className="surface">{snapshot.data!.tree.map((node) => <button className="choice" key={node.id} onClick={() => void fire("session.navigate", { targetEntryId: node.id }, `${node.label}(으)로 이동했습니다.`)}><strong>{node.label}</strong><div className="meta">{node.current ? "현재 위치" : "이 위치에서 이어가기"}</div></button>)}</div></Sheet> : null}
    {panel === "team" ? <Sheet returnFocus={sheetOpener.current} title="하위 작업" onClose={() => setPanel(null)}><div className="surface" style={{ padding: 16 }}><div className="row spread"><strong>진행 중</strong><span>{summary.teams.runningMemberCount}개</span></div><div className="row spread" style={{ marginTop: 12 }}><span>활성 실행</span><span>{summary.teams.activeRunCount}개</span></div><div className="row spread" style={{ marginTop: 12 }}><span>실패</span><span>{summary.teams.failedMemberCount}개</span></div>{summary.background.labels.map((label) => <div className="meta" key={label} style={{ marginTop: 10 }}>• {label === "tests" ? "테스트 실행" : label === "indexing" ? "파일 인덱싱" : label}</div>)}</div></Sheet> : null}
    {panel === "artifacts" ? <Sheet returnFocus={sheetOpener.current} title="파일과 변경점" onClose={() => setPanel(null)}><Suspense fallback={<div className="skeleton" aria-label="변경점을 불러오는 중" />}><ArtifactBrowser host={host} liveSessionId={liveSessionId} images={conversation.entries.filter((entry): entry is Extract<ConversationEntry, { kind: "image" }> => entry.kind === "image")} /></Suspense></Sheet> : null}
    {panel === "terminal" ? <Sheet returnFocus={sheetOpener.current} title="비상 터미널" onClose={() => setPanel(null)}><Suspense fallback={<div className="skeleton" aria-label="터미널을 여는 중" />}><EmergencyTerminal host={host} liveSessionId={liveSessionId} fontSize={preferences.terminalFontSize} onClose={() => setPanel(null)} /></Suspense></Sheet> : null}
  </Shell>
}
