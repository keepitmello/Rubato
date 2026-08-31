import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { EventEnvelope, InteractiveCommandDescriptor, JsonValue, RemoteActionPayloadMap } from "@rubato/remote-protocol"
import { BlockTitle, Button, Chip, Glass, List, ListItem, Messagebar } from "konsta/react"
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
type Panel = "controls" | "commands" | "model" | "compact" | "tree" | "team" | "artifacts" | "terminal" | "rename" | null

type InputAction = "input.submit" | "input.steer" | "input.followUp"

const MODEL_CHOICES = [
  { provider: "openai-codex", modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Codex 기본 경로", changed: "GPT-5.6 Sol로 바꿨습니다." },
  { provider: "kiro", modelId: "claude-opus-5", label: "Claude", description: "긴 글과 코드 작업", changed: "Claude로 바꿨습니다." },
  { provider: "cursor", modelId: "cursor-grok-4.6", label: "Grok 4.6", description: "Cursor Grok Fast", changed: "Grok 4.6으로 바꿨습니다." },
] as const

type ModelChoice = { provider: string; modelId: string; label: string; description: string; changed: string }

function displayedModelChoices(model?: { provider?: string; id?: string; label: string }): readonly ModelChoice[] {
  if (!model?.provider || !model.id) return MODEL_CHOICES
  if (MODEL_CHOICES.some((choice) => choice.provider === model.provider && choice.modelId === model.id)) return MODEL_CHOICES
  return [{ provider: model.provider, modelId: model.id, label: model.label, description: "현재 세션 모델", changed: `${model.label}으로 바꿨습니다.` }, ...MODEL_CHOICES]
}

const EFFORT_CHOICES = [
  { level: "low", label: "낮음" },
  { level: "medium", label: "보통" },
  { level: "high", label: "높음" },
] as const

function humanThinking(value?: string): string {
  return value === "low" ? "낮은 추론" : value === "medium" ? "보통 추론" : value === "high" ? "높은 추론" : "기본 추론"
}

function findPageScrollOwner(from: Element | null): HTMLElement | null {
  return from?.closest(".k-page") ?? null
}

function isNearBottom(owner: HTMLElement): boolean {
  return owner.scrollHeight - owner.scrollTop - owner.clientHeight < 120
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
  const [streamGeneration, setStreamGeneration] = useState(0)
  const [awaitingAssistantCount, setAwaitingAssistantCount] = useState<number | null>(null)
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
  const [renameDraft, setRenameDraft] = useState("")
  const composing = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const submitRef = useRef<() => void>(() => undefined)
  const sheetOpener = useRef<HTMLElement | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const pageAnchor = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const landedAtLatest = useRef(false)
  const olderPreserve = useRef<{ previousHeight: number; previousTop: number } | null>(null)

  useEffect(() => { conversationRef.current = conversation }, [conversation])
  useEffect(() => { landedAtLatest.current = false }, [hostId, liveSessionId])
  useEffect(() => {
    if (!snapshot.data) return
    const data = snapshot.data
    const params = new URLSearchParams(location.search)
    const entries = params.get("state") === "empty" ? [] : params.get("state") === "partial" ? [...data.entries, { id: "partial", kind: "message", role: "assistant", text: "계속 확인하고 있", streaming: true } satisfies ConversationEntry] : data.entries
    const fixtureRequest: UiRequest | undefined = params.get("ui") === "confirm" ? { requestId: "fixture-ui-request", kind: "confirm", title: "이 변경을 적용할까요?", message: "현재 작업 파일에 접근성 수정을 적용합니다." } : undefined
    setConversation((state) => {
      if (state.snapshotInstalled && !state.requiresSnapshot && data.lastSeq === state.lastSeq && params.get("state") !== "partial" && params.get("state") !== "empty") return state
      return applyConversationSnapshot({ ...data, entries: entries.slice(-100), ...((fixtureRequest ?? data.uiRequest) ? { uiRequest: (fixtureRequest ?? data.uiRequest)! } : {}) }, state)
    })
  }, [snapshot.dataUpdatedAt])
  useEffect(() => {
    if (!conversation.requiresSnapshot || !host) return
    void queryClient.invalidateQueries({ queryKey: ["snapshot", hostId, liveSessionId], exact: true, refetchType: "none" })
      .then(() => snapshot.refetch())
      .catch(() => undefined)
  }, [conversation.requiresSnapshot, conversation.recoveryVersion, host, hostId, liveSessionId, queryClient])
  useEffect(() => {
    if (snapshot.data?.summary.lifecycle !== "starting") return
    const timer = window.setTimeout(() => { void snapshot.refetch() }, 500)
    return () => window.clearTimeout(timer)
  }, [snapshot.data?.summary.lifecycle, snapshot.dataUpdatedAt])
  useEffect(() => {
    const field = composer.current
    if (!field) return
    field.style.height = "auto"
    const height = Math.min(field.scrollHeight, 120)
    field.style.height = `${Math.max(46, height)}px`
    field.style.overflowY = field.scrollHeight > 120 ? "auto" : "hidden"
  }, [draft])
  useEffect(() => {
    const field = composer.current
    if (!field) return
    const onCompositionStart = () => { composing.current = true }
    const onCompositionEnd = () => { composing.current = false }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        submitRef.current()
      }
    }
    field.addEventListener("compositionstart", onCompositionStart)
    field.addEventListener("compositionend", onCompositionEnd)
    field.addEventListener("keydown", onKeyDown)
    return () => {
      field.removeEventListener("compositionstart", onCompositionStart)
      field.removeEventListener("compositionend", onCompositionEnd)
      field.removeEventListener("keydown", onKeyDown)
    }
  }, [host, snapshot.data?.summary.liveSessionId])

  const batcher = useMemo(() => new DeltaBatcher((events) => setConversation((state) => events.reduce(reduceConversation, state))), [])
  useEffect(() => {
    if (!host) return
    const stream = new SessionStream(host, liveSessionId, () => conversationRef.current.lastSeq, (event: EventEnvelope) => batcher.push(event), setConnection)
    stream.start()
    return () => { stream.stop(); batcher.dispose() }
  }, [batcher, host, liveSessionId, streamGeneration])
  useEffect(() => {
    const owner = findPageScrollOwner(pageAnchor.current)
    if (!owner) return
    const onScroll = () => { nearBottom.current = isNearBottom(owner) }
    owner.addEventListener("scroll", onScroll, { passive: true })
    return () => owner.removeEventListener("scroll", onScroll)
  }, [snapshot.data?.summary.liveSessionId])
  useLayoutEffect(() => {
    const owner = findPageScrollOwner(pageAnchor.current)
    if (!owner || conversation.entries.length === 0) return
    if (!landedAtLatest.current) {
      landedAtLatest.current = true
      owner.scrollTo({ top: owner.scrollHeight })
      nearBottom.current = true
      return
    }
    const preserve = olderPreserve.current
    if (preserve) {
      olderPreserve.current = null
      owner.scrollTop = preserve.previousTop + (owner.scrollHeight - preserve.previousHeight)
      nearBottom.current = isNearBottom(owner)
      return
    }
    if (nearBottom.current) owner.scrollTo({ top: owner.scrollHeight, behavior: "smooth" })
  }, [conversation.entries])
  useEffect(() => {
    if (awaitingAssistantCount === null) return
    const completed = conversation.entries.filter((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.streaming).length
    if (completed > awaitingAssistantCount) {
      setAwaitingAssistantCount(null)
      return
    }
    const reconnect = window.setInterval(() => setStreamGeneration((generation) => generation + 1), 2_000)
    return () => window.clearInterval(reconnect)
  }, [awaitingAssistantCount, conversation.entries])

  const action = useMutation({
    mutationFn: async ({ type, text, imageIds }: { type: InputAction; text: string; imageIds: readonly string[] }) => {
      if (!host) throw new Error("이 호스트를 찾지 못했어요.")
      if (type === "input.steer") return sendAction(host, liveSessionId, "input.steer", { text, imageIds })
      if (type === "input.followUp") return sendAction(host, liveSessionId, "input.followUp", { text, imageIds })
      return sendAction(host, liveSessionId, "input.submit", { text, imageIds, delivery: "auto" })
    },
    onSuccess: (_value, variables) => {
      setDraft("")
      setActionError("")
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl)
      setAttachments([])
      setConversation((state) => ({ ...state, entries: [...state.entries, { id: `optimistic-${crypto.randomUUID()}`, kind: "message", role: "user", text: variables.text || `이미지 ${variables.imageIds.length}개` }, ...(fixtureMode ? [{ id: crypto.randomUUID(), kind: "message" as const, role: "assistant" as const, text: variables.type === "input.followUp" ? "다음 차례에 처리하도록 추가했습니다…" : "요청을 받아 작업을 시작했습니다…", streaming: true }] : [])] }))
      if (!fixtureMode) {
        setAwaitingAssistantCount(conversationRef.current.entries.filter((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.streaming).length)
        setStreamGeneration((generation) => generation + 1)
      }
      setAnnouncement(variables.type === "input.followUp" ? "다음 차례에 처리할 요청을 보냈습니다." : variables.type === "input.steer" ? "즉시 반영할 지시를 보냈습니다." : "메시지를 보냈습니다.")
    },
    onError: (cause) => setActionError(cause instanceof Error ? cause.message : "메시지를 보내지 못했어요."),
  })
  const summary = snapshot.data?.summary
  const sessionReady = summary?.lifecycle === "ready"
  const working = summary?.execution === "working" || new URLSearchParams(location.search).get("state") === "working"
  const submit = () => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || action.isPending || connection === "offline" || !sessionReady) return
    action.mutate({ type: working ? delivery : "input.submit", text, imageIds: attachments.map((attachment) => attachment.imageId) })
  }
  submitRef.current = submit
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
      const owner = findPageScrollOwner(pageAnchor.current)
      if (owner) olderPreserve.current = { previousHeight: owner.scrollHeight, previousTop: owner.scrollTop }
      const first = conversation.entries[0]
      const older = await fetchOlderMessages(host, liveSessionId, first?.id)
      setConversation((state) => ({ ...state, entries: [...older, ...state.entries].slice(-1_000) }))
      if (older.length < 100) setHasOlder(false)
    } finally { setOlderLoading(false) }
  }
  const fire = async <T extends keyof RemoteActionPayloadMap>(type: T, payload: RemoteActionPayloadMap[T], message: string) => {
    if (!host) return
    const keepSheet = type === "session.rename" || type === "model.set" || type === "thinking.set"
    try {
      await sendAction(host, liveSessionId, type, payload, snapshot.data?.revision)
      if (keepSheet) await snapshot.refetch()
      setPanel(null)
      setActionError("")
      setAnnouncement(message)
    } catch (cause) {
      if (!keepSheet) setPanel(null)
      setActionError(cause instanceof Error ? cause.message : "요청을 마치지 못했어요.")
    }
  }
  const openModelSettings = (event: { currentTarget: HTMLElement }) => {
    sheetOpener.current = event.currentTarget
    setPanel("model")
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
  const currentModel = (provider: string, modelId: string) => summary?.model.provider === provider && summary.model.id === modelId
  const currentEffort = (level: string) => summary?.model.thinkingLevel === level

  if (!host) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>연결된 Mac을 찾지 못했어요.</strong><p>설정에서 이 Mac을 다시 연결하세요.</p><button className="secondary" onClick={() => navigate("/settings")}>설정 열기</button></div></main></Shell>
  if (snapshot.isLoading) return <Shell title="세션" back="/"><main className="content"><div className="skeleton" /><div className="skeleton" /></main></Shell>
  if (snapshot.isError || !summary) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>대화를 불러오지 못했어요.</strong><p>Mac의 연결 상태를 확인한 뒤 다시 시도하세요.</p><button className="secondary" onClick={() => void snapshot.refetch()}>다시 시도</button></div></main></Shell>

  const sendLabel = working ? delivery === "input.followUp" ? "다음 차례에 보내기" : "즉시 반영할 지시 보내기" : "메시지 보내기"
  const sendDisabled = (!draft.trim() && attachments.length === 0) || action.isPending || uploading || connection === "offline" || !sessionReady
  const abortInstead = working && !draft.trim() && attachments.length === 0

  return <Shell title={summary.title} back="/" action={<Button clear small aria-label="세션 제어 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}>•••</Button>}>
    {(connection === "offline" || new URLSearchParams(location.search).get("state") === "offline") ? <StateBanner>연결이 끊겼어요. 대화는 그대로 두고 다시 연결하고 있습니다.</StateBanner> : connection === "connecting" ? <StateBanner>Mac에 다시 연결하는 중…</StateBanner> : null}
    {!sessionReady ? <StateBanner>Mac에서 세션을 준비하고 있어요…</StateBanner> : null}
    {conversation.requiresSnapshot ? <StateBanner kind="error">일부 업데이트를 놓쳤어요. 현재 대화를 다시 불러옵니다. <button className="text-button" onClick={() => void snapshot.refetch()}>다시 시도</button></StateBanner> : null}
    <div ref={pageAnchor} className="session-head">
      <div className="row spread"><span className="status"><span className={`status-dot ${working ? "working" : ""}`} />{working ? "작업 중" : "대기"}</span><span className="meta path">{host.displayName} · {summary.cwd.replace(/^\/Users\/[^/]+/, "~")}</span></div>
      <div className="meta" style={{ marginTop: 8 }}>
        <Chip component="button" aria-label={`${summary.model.label} 모델 설정`} onClick={openModelSettings}>{summary.model.label}</Chip>
        <Chip component="button" aria-label={`${humanThinking(summary.model.thinkingLevel)} 설정`} onClick={openModelSettings}>{humanThinking(summary.model.thinkingLevel)}</Chip>
        {summary.context.remainingPercent !== undefined ? <Chip>문맥 {summary.context.remainingPercent}% 남음</Chip> : null}
        {summary.background.activeCount > 0 ? <Chip component="button" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("team") }}>하위 작업 {summary.background.activeCount}개</Chip> : null}
      </div>
    </div>
    {conversation.uiRequest ? <section className="surface ui-request" aria-labelledby="ui-request-title">
      <h2 id="ui-request-title" style={{ margin: 0, fontSize: "1rem" }}>{conversation.uiRequest.title}</h2>{conversation.uiRequest.message ? <p className="meta">{conversation.uiRequest.message}</p> : null}
      {conversation.uiRequest.kind === "select" ? <div className="ui-options">{conversation.uiRequest.options?.map((option) => <Button key={option.value} outline onClick={() => void respondToUi(conversation.uiRequest!, option.value)}>{option.label}</Button>)}</div> : null}
      {conversation.uiRequest.kind === "confirm" ? <div className="sheet-actions"><Button outline onClick={() => void respondToUi(conversation.uiRequest!, false)}>아니요</Button><Button onClick={() => void respondToUi(conversation.uiRequest!, true)}>적용</Button></div> : null}
      {conversation.uiRequest.kind === "input" ? <div className="ui-options"><label className="field"><span className="field-label">응답</span><input className="input" value={uiInput} placeholder={conversation.uiRequest.placeholder} onChange={(event) => setUiInput(event.target.value)} /></label><Button disabled={!uiInput.trim()} onClick={() => void respondToUi(conversation.uiRequest!, uiInput.trim())}>응답 보내기</Button></div> : null}
    </section> : null}
    <main>
      {hasOlder && conversation.entries.length > 0 ? <div style={{ textAlign: "center" }}><Button clear disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "불러오는 중…" : "이전 대화 보기"}</Button></div> : null}
      {conversation.entries.length === 0 ? <div className="surface empty"><strong>무엇을 할지 알려주세요.</strong><p className="meta">메시지를 보내면 이 Mac의 같은 Rubato 세션에서 작업을 시작합니다.</p></div> : <Conversation entries={conversation.entries} host={host} liveSessionId={liveSessionId} />}
    </main>
    {actionError && panel !== "rename" && panel !== "model" ? <div className="state-banner error" role="alert">{actionError} <button className="text-button" onClick={submit}>다시 보내기</button></div> : null}
    <div className="composer-shell">
      {working || attachments.length > 0 ? <Glass className="composer-extras">
        {working ? <div className="delivery-toggle" aria-label="작업 중 메시지 처리"><Chip component="button" aria-pressed={delivery === "input.steer"} onClick={() => setDelivery("input.steer")}>즉시 반영</Chip><Chip component="button" aria-pressed={delivery === "input.followUp"} onClick={() => setDelivery("input.followUp")}>다음 차례</Chip></div> : null}
        {attachments.length > 0 ? <div className="attachment-row" aria-label="첨부 이미지">{attachments.map((attachment) => <div className="attachment" key={attachment.imageId}><img src={attachment.previewUrl} alt="" /><span>{attachment.name}</span><Button clear small aria-label={`${attachment.name} 제거`} onClick={() => setAttachments((current) => current.filter((item) => item.imageId !== attachment.imageId))}>×</Button></div>)}</div> : null}
      </Glass> : null}
      <input ref={imageInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" aria-label="이미지 파일 선택" onChange={(event) => void attachImage(event.target.files?.[0])} />
      <label className="sr-only" htmlFor="message">메시지</label>
      <Messagebar
        className="session-messagebar"
        textareaId="message"
        placeholder={connection === "offline" ? "연결되면 보낼 수 있어요" : !sessionReady ? "세션을 준비하고 있어요" : working ? "추가 지시 보내기" : "메시지"}
        value={draft}
        disabled={connection === "offline"}
        left={<Button clear rounded inline aria-label="도구와 명령 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}>＋</Button>}
        right={abortInstead
          ? <Button rounded onClick={() => void fire("agent.abort", {}, "작업을 중단했습니다.")}>중단</Button>
          : <Button rounded aria-label={sendLabel} disabled={sendDisabled} onClick={submit}>↑</Button>}
        onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        onChange={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        ref={(node) => { composer.current = node?.querySelector("textarea") ?? null }}
      />
    </div>
    <div className="live-region" aria-live="polite">{announcement}</div>

    {panel === "controls" ? <Sheet returnFocus={sheetOpener.current} title="세션 도구" onClose={() => setPanel(null)}><List strong inset>
      <ListItem title="이름 바꾸기" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => { setRenameDraft(summary.title); setPanel("rename") } }} />
      <ListItem title="스킬과 명령" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("commands") }} />
      <ListItem title="이미지 추가" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => { setPanel(null); requestAnimationFrame(() => imageInput.current?.click()) } }} />
      <ListItem title="모델" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("model") }} />
      <ListItem title="대화 정리" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("compact") }} />
      <ListItem title="대화 가지" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("tree") }} />
      <ListItem title="하위 작업" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("team") }} />
      <ListItem title="파일과 변경점" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("artifacts") }} />
      <ListItem title="비상 터미널" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel("terminal") }} />
      <ListItem title="다시 불러오기" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => void fire("session.reload", {}, "세션을 다시 불러왔습니다.") }} />
      <ListItem title="닫기" link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => setPanel(null) }} />
    </List></Sheet> : null}
    {panel === "rename" ? <Sheet returnFocus={sheetOpener.current} title="이름 바꾸기" onClose={() => setPanel(null)}>{actionError ? <div className="state-banner error" role="alert">{actionError}</div> : null}<label className="field"><span className="field-label">세션 이름</span><input className="input" id="session-rename" aria-label="세션 이름" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} placeholder="표시할 이름" /></label><div className="sheet-actions"><Button outline onClick={() => setPanel(null)}>취소</Button><Button disabled={!renameDraft.trim()} onClick={() => void fire("session.rename", { name: renameDraft.trim() }, "이름을 바꿨습니다.")}>저장</Button></div></Sheet> : null}
    {panel === "commands" ? <Sheet returnFocus={sheetOpener.current} title="스킬과 명령" onClose={() => setPanel(null)}><p className="meta">이 세션에서 사용할 수 있는 명령만 표시합니다.</p>{availableCommands.length === 0 ? <p className="meta">원격에서 사용할 수 있는 명령이 없습니다.</p> : <List strong inset>{availableCommands.map((command) => <ListItem key={command.name} title={`/${command.name}`} subtitle={`${command.description}${command.remoteMode === "terminal-only" ? " · 비상 터미널 필요" : ""}`} link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => runCommand(command) }} />)}</List>}</Sheet> : null}
    {panel === "model" ? <Sheet returnFocus={sheetOpener.current} title="모델과 추론" onClose={() => setPanel(null)}>{actionError ? <div className="state-banner error" role="alert">{actionError}</div> : null}<List strong inset>{displayedModelChoices(summary.model).map((choice) => { const selected = currentModel(choice.provider, choice.modelId); return <ListItem key={`${choice.provider}/${choice.modelId}`} title={choice.label} subtitle={choice.description} after={selected ? "현재 선택" : undefined} link linkComponent="button" chevron={false} menuListItem menuListItemActive={selected} linkProps={{ type: "button", "aria-current": selected ? "true" : undefined, onClick: () => void fire("model.set", { provider: choice.provider, modelId: choice.modelId }, choice.changed) }} /> })}</List><BlockTitle>추론 강도</BlockTitle><List strong inset>{EFFORT_CHOICES.map((choice) => { const selected = currentEffort(choice.level); return <ListItem key={choice.level} title={choice.label} after={selected ? "현재 선택" : undefined} link linkComponent="button" chevron={false} menuListItem menuListItemActive={selected} linkProps={{ type: "button", "aria-current": selected ? "true" : undefined, onClick: () => void fire("thinking.set", { level: choice.level }, `${choice.label}으로 바꿨습니다.`) }} /> })}</List></Sheet> : null}
    {panel === "compact" ? <Sheet returnFocus={sheetOpener.current} title="대화 정리" onClose={() => setPanel(null)}><p>오래된 대화를 요약해 문맥 공간을 확보합니다. 현재 작업과 파일은 유지됩니다.</p><label className="field"><span className="field-label">남길 내용 (선택)</span><input className="input" id="compact-instructions" placeholder="예: 접근성 결정은 모두 유지" /></label><div className="sheet-actions"><Button outline onClick={() => setPanel(null)}>취소</Button><Button onClick={() => { const instructions = (document.getElementById("compact-instructions") as HTMLInputElement).value; void fire("session.compact", instructions ? { instructions } : {}, "대화 정리를 시작했습니다.") }}>정리 시작</Button></div></Sheet> : null}
    {panel === "tree" ? <Sheet returnFocus={sheetOpener.current} title="대화 가지" onClose={() => setPanel(null)}><List strong inset>{snapshot.data!.tree.map((node) => <ListItem key={node.id} title={node.label} subtitle={node.current ? "현재 위치" : "이 위치에서 이어가기"} link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => void fire("session.navigate", { targetEntryId: node.id }, `${node.label}(으)로 이동했습니다.`) }} />)}</List></Sheet> : null}
    {panel === "team" ? <Sheet returnFocus={sheetOpener.current} title="하위 작업" onClose={() => setPanel(null)}><List strong inset><ListItem title="진행 중" after={`${summary.teams.runningMemberCount}개`} /><ListItem title="활성 실행" after={`${summary.teams.activeRunCount}개`} /><ListItem title="실패" after={`${summary.teams.failedMemberCount}개`} />{summary.background.labels.map((label) => <ListItem key={label} title={label === "tests" ? "테스트 실행" : label === "indexing" ? "파일 인덱싱" : label} />)}</List></Sheet> : null}
    {panel === "artifacts" ? <Sheet returnFocus={sheetOpener.current} title="파일과 변경점" onClose={() => setPanel(null)}><Suspense fallback={<div className="skeleton" aria-label="변경점을 불러오는 중" />}><ArtifactBrowser host={host} liveSessionId={liveSessionId} images={conversation.entries.filter((entry): entry is Extract<ConversationEntry, { kind: "image" }> => entry.kind === "image")} /></Suspense></Sheet> : null}
    {panel === "terminal" ? <Sheet returnFocus={sheetOpener.current} title="비상 터미널" onClose={() => setPanel(null)}><Suspense fallback={<div className="skeleton" aria-label="터미널을 여는 중" />}><EmergencyTerminal host={host} liveSessionId={liveSessionId} fontSize={preferences.terminalFontSize} onClose={() => setPanel(null)} /></Suspense></Sheet> : null}
  </Shell>
}
