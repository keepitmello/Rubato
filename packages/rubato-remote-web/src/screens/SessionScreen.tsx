import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { EventEnvelope, InteractiveCommandDescriptor, JsonValue, RemoteActionPayloadMap } from "@rubato/remote-protocol"
import { BlockTitle, Button, Chip, Glass, List, ListItem, Messagebar } from "konsta/react"
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Conversation } from "../components/Conversation"
import { AppIcon, type AppIconName } from "../components/Icon"
import { EmptyState, Sheet, Shell, StateBanner } from "../components/Shell"
import { fetchOlderMessages, fetchSnapshot, fixtureMode, sendAction, SessionStream, uploadImage } from "../lib/api"
import { applyConversationSnapshot, DeltaBatcher, reduceConversation } from "../lib/conversation"
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

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~")
}

function findPageScrollOwner(from: Element | null): HTMLElement | null {
  return from?.closest(".k-page") ?? null
}

function isNearBottom(owner: HTMLElement): boolean {
  return owner.scrollHeight - owner.scrollTop - owner.clientHeight < 120
}

const supportedNativeCommands = new Set(["abort", "compact", "reload"])
const remotelyAvailable = (command: InteractiveCommandDescriptor): boolean => command.remoteMode !== "native-action" || supportedNativeCommands.has(command.name)

function ControlButton({ icon, title, detail, onClick, danger = false }: { icon: AppIconName; title: string; detail: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" className={`control-tile ${danger ? "control-tile-danger" : ""}`} aria-label={title} onClick={onClick}>
    <span className="control-tile-icon" aria-hidden="true"><AppIcon name={icon} size={21} /></span>
    <span className="control-tile-copy"><strong>{title}</strong><small>{detail}</small></span>
    <AppIcon name="chevron-right" size={17} />
  </button>
}

function SheetNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`sheet-notice ${error ? "sheet-notice-error" : ""}`} role={error ? "alert" : "status"}>
    <AppIcon name={error ? "warning" : "check"} size={18} />
    <span>{children}</span>
  </div>
}

export function SessionScreen({ hostId, liveSessionId }: { hostId: string; liveSessionId: string }) {
  const storedHosts = useAppStore((state) => state.hosts)
  const preferences = useAppStore((state) => state.preferences)
  const queryClient = useQueryClient()
  const host = storedHosts.find((item) => item.hostId === hostId) ?? (fixtureMode ? { ...fixtureHost, hostId } : undefined)
  const snapshot = useQuery({
    queryKey: ["snapshot", hostId, liveSessionId],
    queryFn: () => fetchSnapshot(host!, liveSessionId),
    enabled: Boolean(host),
  })
  const [conversation, setConversation] = useState<ConversationState>({
    entries: [],
    lastSeq: 0,
    requiresSnapshot: false,
    snapshotInstalled: false,
    recoveryVersion: 0,
    bufferedEvents: [],
  })
  const conversationRef = useRef(conversation)
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">(navigator.onLine ? "connecting" : "offline")
  const [streamGeneration, setStreamGeneration] = useState(0)
  const [awaitingAssistantCount, setAwaitingAssistantCount] = useState<number | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [draft, setDraft] = useState("")
  const [delivery, setDelivery] = useState<"input.steer" | "input.followUp">("input.followUp")
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
    const entries = params.get("state") === "empty"
      ? []
      : params.get("state") === "partial"
        ? [...data.entries, { id: "partial", kind: "message", role: "assistant", text: "계속 확인하고 있", streaming: true } satisfies ConversationEntry]
        : data.entries
    const fixtureRequest: UiRequest | undefined = params.get("ui") === "confirm"
      ? { requestId: "fixture-ui-request", kind: "confirm", title: "이 변경을 적용할까요?", message: "현재 작업 파일에 접근성 수정을 적용합니다." }
      : undefined
    setConversation((state) => {
      if (state.snapshotInstalled && !state.requiresSnapshot && data.lastSeq === state.lastSeq && params.get("state") !== "partial" && params.get("state") !== "empty") return state
      return applyConversationSnapshot({
        ...data,
        entries: entries.slice(-100),
        ...((fixtureRequest ?? data.uiRequest) ? { uiRequest: (fixtureRequest ?? data.uiRequest)! } : {}),
      }, state)
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
    const stream = new SessionStream(
      host,
      liveSessionId,
      () => conversationRef.current.lastSeq,
      (event: EventEnvelope) => batcher.push(event),
      setConnection,
    )
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
      if (variables.type === "input.steer") setDelivery("input.followUp")
      setConversation((state) => ({
        ...state,
        entries: [
          ...state.entries,
          { id: `optimistic-${crypto.randomUUID()}`, kind: "message", role: "user", text: variables.text || `이미지 ${variables.imageIds.length}개` },
          ...(fixtureMode ? [{
            id: crypto.randomUUID(),
            kind: "message" as const,
            role: "assistant" as const,
            text: variables.type === "input.followUp" ? "다음 차례에 처리하도록 추가했습니다…" : "요청을 받아 작업을 시작했습니다…",
            streaming: true,
          }] : []),
        ],
      }))
      if (!fixtureMode) {
        setAwaitingAssistantCount(conversationRef.current.entries.filter((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.streaming).length)
        setStreamGeneration((generation) => generation + 1)
      }
      setAnnouncement(variables.type === "input.followUp"
        ? "다음 차례에 처리할 요청을 보냈습니다."
        : variables.type === "input.steer"
          ? "즉시 반영할 지시를 보냈습니다."
          : "메시지를 보냈습니다.")
    },
    onError: (cause) => setActionError(cause instanceof Error ? cause.message : "메시지를 보내지 못했어요."),
  })

  const summary = snapshot.data?.summary
  const sessionReady = summary?.lifecycle === "ready"
  const working = summary?.execution === "working" || new URLSearchParams(location.search).get("state") === "working"

  useEffect(() => {
    if (!working) setDelivery("input.followUp")
  }, [working])

  const submit = () => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || action.isPending || connection === "offline" || !sessionReady) return
    action.mutate({
      type: working ? delivery : "input.submit",
      text,
      imageIds: attachments.map((attachment) => attachment.imageId),
    })
  }
  submitRef.current = submit

  const attachImage = async (file?: File) => {
    if (!host || !file) return
    setUploading(true)
    setActionError("")
    try {
      const attachment = await uploadImage(host, liveSessionId, file)
      setAttachments((current) => [...current, attachment])
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "이미지를 추가하지 못했어요.")
    } finally {
      setUploading(false)
      if (imageInput.current) imageInput.current.value = ""
    }
  }

  const respondToUi = async (request: UiRequest, value: JsonValue) => {
    if (!host) return
    try {
      await sendAction(host, liveSessionId, "ui.respond", { requestId: request.requestId, value }, snapshot.data?.revision)
      setConversation((state) => ({ ...state, uiRequest: undefined }))
      setUiInput("")
      setAnnouncement("응답을 보냈습니다.")
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "응답을 보내지 못했어요.")
    }
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
    } finally {
      setOlderLoading(false)
    }
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
    if (command.name === "compact") {
      setPanel("compact")
      return
    }
    if (command.name === "reload") {
      void fire("session.reload", {}, "세션을 다시 불러왔습니다.")
      return
    }
    if (command.name === "abort") void fire("agent.abort", {}, "작업을 중단했습니다.")
  }

  const availableCommands = snapshot.data?.commands.filter(remotelyAvailable) ?? []
  const currentModel = (provider: string, modelId: string) => summary?.model.provider === provider && summary.model.id === modelId
  const currentEffort = (level: string) => summary?.model.thinkingLevel === level

  if (!host) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>연결된 Mac을 찾지 못했어요.</strong><p>설정에서 이 Mac을 다시 연결하세요.</p><button className="secondary" type="button" onClick={() => navigate("/settings")}>설정 열기</button></div></main></Shell>
  if (snapshot.isLoading) return <Shell title="세션" back="/"><main className="content session-loading"><div className="skeleton skeleton-header" /><div className="skeleton" /><div className="skeleton skeleton-short" /></main></Shell>
  if (snapshot.isError || !summary) return <Shell title="세션" back="/"><main className="content"><div className="surface error-box" role="alert"><strong>대화를 불러오지 못했어요.</strong><p>Mac의 연결 상태를 확인한 뒤 다시 시도하세요.</p><button className="secondary" type="button" onClick={() => void snapshot.refetch()}>다시 시도</button></div></main></Shell>

  const sendLabel = working
    ? delivery === "input.followUp" ? "다음 차례에 보내기" : "즉시 반영할 지시 보내기"
    : "메시지 보내기"
  const sendDisabled = (!draft.trim() && attachments.length === 0) || action.isPending || uploading || connection === "offline" || !sessionReady
  const abortInstead = working && !draft.trim() && attachments.length === 0
  const toolEntries = conversation.entries.filter((entry) => entry.kind === "tool")
  const runningTools = toolEntries.filter((entry) => entry.status === "running").length
  const failedTools = toolEntries.filter((entry) => entry.status === "failed").length
  const currentActivity = runningTools > 0
    ? `도구 ${runningTools}개 실행 중`
    : awaitingAssistantCount !== null
      ? "응답을 기다리는 중"
      : working
        ? "작업을 이어가는 중"
        : "새 요청을 기다리는 중"

  return <Shell
    title={summary.title}
    back="/"
    className="session-screen"
    action={<button className="icon-button navbar-icon-button" type="button" aria-label="세션 제어 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}><AppIcon name="more" size={22} /></button>}
  >
    {(connection === "offline" || new URLSearchParams(location.search).get("state") === "offline")
      ? <StateBanner>연결이 끊겼어요. 대화는 그대로 두고 다시 연결하고 있습니다.</StateBanner>
      : connection === "connecting" ? <StateBanner kind="notice">Mac에 다시 연결하는 중…</StateBanner> : null}
    {!sessionReady ? <StateBanner kind="notice">Mac에서 세션을 준비하고 있어요…</StateBanner> : null}
    {conversation.requiresSnapshot ? <StateBanner kind="error">일부 업데이트를 놓쳤어요. 현재 대화를 다시 불러옵니다. <button className="text-button text-button-inline" type="button" onClick={() => void snapshot.refetch()}>다시 시도</button></StateBanner> : null}

    <div ref={pageAnchor} className="session-context-bar">
      <div className="session-context-primary">
        <span className={`live-status live-status-${working ? "working" : "idle"}`}><span className={`status-dot ${working ? "working" : "idle"}`} />{working ? "작업 중" : "대기"}</span>
        <span className="session-context-path"><AppIcon name="mac" size={15} />{host.displayName}<span aria-hidden="true">·</span>{shortPath(summary.cwd)}</span>
      </div>
      <div className="session-context-chips" aria-label="세션 설정">
        <Chip component="button" aria-label={`${summary.model.label} 모델 설정`} onClick={openModelSettings}><AppIcon name="model" size={15} />{summary.model.label}</Chip>
        <Chip component="button" aria-label={`${humanThinking(summary.model.thinkingLevel)} 설정`} onClick={openModelSettings}><AppIcon name="brain" size={15} />{humanThinking(summary.model.thinkingLevel)}</Chip>
        {summary.context.remainingPercent !== undefined ? <Chip><AppIcon name="clock" size={15} />문맥 {summary.context.remainingPercent}%</Chip> : null}
        {summary.background.activeCount > 0 ? <Chip component="button" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("team") }}><AppIcon name="people" size={15} />하위 작업 {summary.background.activeCount}</Chip> : null}
      </div>
    </div>

    {working ? <section className="active-work-bar" aria-label="현재 작업 상태">
      <div className="active-work-indicator" aria-hidden="true"><span /><span /><span /></div>
      <div className="active-work-copy"><strong>{currentActivity}</strong><span>{toolEntries.length > 0 ? `작업 기록 ${toolEntries.length}개${failedTools > 0 ? ` · 실패 ${failedTools}개` : ""}` : "진행 상황은 대화에 이어서 표시됩니다."}</span></div>
    </section> : null}

    {conversation.uiRequest ? <section className="surface ui-request" aria-labelledby="ui-request-title">
      <span className="ui-request-icon" aria-hidden="true"><AppIcon name="warning" size={21} /></span>
      <div className="ui-request-content">
        <p className="section-kicker">응답 필요</p>
        <h2 id="ui-request-title">{conversation.uiRequest.title}</h2>
        {conversation.uiRequest.message ? <p>{conversation.uiRequest.message}</p> : null}
        {conversation.uiRequest.kind === "select" ? <div className="ui-options">{conversation.uiRequest.options?.map((option) => <Button key={option.value} outline onClick={() => void respondToUi(conversation.uiRequest!, option.value)}>{option.label}</Button>)}</div> : null}
        {conversation.uiRequest.kind === "confirm" ? <div className="sheet-actions"><Button outline onClick={() => void respondToUi(conversation.uiRequest!, false)}>아니요</Button><Button onClick={() => void respondToUi(conversation.uiRequest!, true)}>적용</Button></div> : null}
        {conversation.uiRequest.kind === "input" ? <div className="ui-options"><label className="field"><span className="field-label">응답</span><input className="input" value={uiInput} placeholder={conversation.uiRequest.placeholder} onChange={(event) => setUiInput(event.target.value)} /></label><Button disabled={!uiInput.trim()} onClick={() => void respondToUi(conversation.uiRequest!, uiInput.trim())}>응답 보내기</Button></div> : null}
      </div>
    </section> : null}

    <main className="conversation-region">
      {hasOlder && conversation.entries.length > 0 ? <div className="older-messages"><Button clear disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "불러오는 중…" : "이전 대화 보기"}</Button></div> : null}
      {conversation.entries.length === 0
        ? <EmptyState icon="spark" title="무엇을 할지 알려주세요" detail="메시지를 보내면 이 Mac의 같은 Rubato 세션에서 작업을 시작합니다." />
        : <Conversation entries={conversation.entries} host={host} liveSessionId={liveSessionId} />}
    </main>

    {actionError && panel !== "rename" && panel !== "model" ? <div className="composer-error" role="alert"><AppIcon name="warning" size={17} /><span>{actionError}</span><button className="text-button text-button-inline" type="button" onClick={submit}>다시 보내기</button></div> : null}

    <div className="composer-shell">
      {working || attachments.length > 0 ? <Glass className="composer-extras">
        {working ? <div className="delivery-toggle" aria-label="작업 중 메시지 처리">
          <button type="button" aria-pressed={delivery === "input.followUp"} onClick={() => setDelivery("input.followUp")}><AppIcon name="queue" size={16} /><span><strong>다음 차례</strong><small>현재 작업 뒤에 시작</small></span></button>
          <button type="button" aria-pressed={delivery === "input.steer"} onClick={() => setDelivery("input.steer")}><AppIcon name="send" size={16} /><span><strong>현재 작업에 반영</strong><small>다음 판단부터 반영</small></span></button>
        </div> : null}
        {attachments.length > 0 ? <div className="attachment-row" aria-label="첨부 이미지">{attachments.map((attachment) => <div className="attachment" key={attachment.imageId}><img src={attachment.previewUrl} alt="" /><span>{attachment.name}</span><Button clear small aria-label={`${attachment.name} 제거`} onClick={() => setAttachments((current) => current.filter((item) => item.imageId !== attachment.imageId))}><AppIcon name="close" size={16} /></Button></div>)}</div> : null}
      </Glass> : null}

      <input ref={imageInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" aria-label="이미지 파일 선택" onChange={(event) => void attachImage(event.target.files?.[0])} />
      <label className="sr-only" htmlFor="message">메시지</label>
      <Messagebar
        className="session-messagebar"
        textareaId="message"
        placeholder={connection === "offline" ? "연결되면 보낼 수 있어요" : !sessionReady ? "세션을 준비하고 있어요" : working ? "추가 요청을 입력하세요" : "메시지"}
        value={draft}
        disabled={connection === "offline"}
        left={<Button clear rounded inline aria-label="도구와 명령 열기" onClick={(event) => { sheetOpener.current = event.currentTarget; setPanel("controls") }}><AppIcon name="plus" size={22} /></Button>}
        right={abortInstead
          ? <Button className="composer-stop-button" rounded aria-label="작업 중단" onClick={() => void fire("agent.abort", {}, "작업을 중단했습니다.")}><AppIcon name="stop" size={17} /><span>중단</span></Button>
          : <Button className="composer-send-button" rounded aria-label={sendLabel} disabled={sendDisabled} onClick={submit}><AppIcon name="send" size={19} /></Button>}
        onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        onChange={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        ref={(node) => { composer.current = node?.querySelector("textarea") ?? null }}
      />
    </div>

    <div className="live-region" aria-live="polite">{announcement}</div>

    {panel === "controls" ? <Sheet returnFocus={sheetOpener.current} title="세션 도구" description="자주 쓰는 제어와 복구 기능입니다." onClose={() => setPanel(null)}>
      <div className="control-grid">
        <ControlButton icon="edit" title="이름 바꾸기" detail="목록에 보일 이름" onClick={() => { setRenameDraft(summary.title); setPanel("rename") }} />
        <ControlButton icon="command" title="스킬과 명령" detail="현재 세션 명령" onClick={() => setPanel("commands")} />
        <ControlButton icon="image" title="이미지 추가" detail="요청에 이미지 첨부" onClick={() => { setPanel(null); requestAnimationFrame(() => imageInput.current?.click()) }} />
        <ControlButton icon="model" title="모델" detail="모델과 추론 변경" onClick={() => setPanel("model")} />
        <ControlButton icon="compress" title="대화 정리" detail="문맥 공간 확보" onClick={() => setPanel("compact")} />
        <ControlButton icon="branch" title="대화 가지" detail="이전 지점에서 이어가기" onClick={() => setPanel("tree")} />
        <ControlButton icon="people" title="하위 작업" detail="팀과 백그라운드 상태" onClick={() => setPanel("team")} />
        <ControlButton icon="file" title="파일과 변경점" detail="차이점과 이미지 보기" onClick={() => setPanel("artifacts")} />
        <ControlButton icon="terminal" title="비상 터미널" detail="실제 TUI에 직접 연결" onClick={() => setPanel("terminal")} />
        <ControlButton icon="refresh" title="다시 불러오기" detail="상태와 확장 새로고침" onClick={() => void fire("session.reload", {}, "세션을 다시 불러왔습니다.")} />
      </div>
      <button className="sheet-dismiss-button" type="button" onClick={() => setPanel(null)}>닫기</button>
    </Sheet> : null}

    {panel === "rename" ? <Sheet returnFocus={sheetOpener.current} title="이름 바꾸기" onClose={() => setPanel(null)}>
      {actionError ? <SheetNotice error>{actionError}</SheetNotice> : null}
      <label className="field"><span className="field-label">세션 이름</span><input className="input" id="session-rename" aria-label="세션 이름" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} placeholder="표시할 이름" /></label>
      <div className="sheet-actions"><Button outline onClick={() => setPanel(null)}>취소</Button><Button disabled={!renameDraft.trim()} onClick={() => void fire("session.rename", { name: renameDraft.trim() }, "이름을 바꿨습니다.")}>저장</Button></div>
    </Sheet> : null}

    {panel === "commands" ? <Sheet returnFocus={sheetOpener.current} title="스킬과 명령" description="이 세션에서 원격으로 사용할 수 있는 명령만 표시합니다." onClose={() => setPanel(null)}>
      {availableCommands.length === 0 ? <p className="sheet-empty-copy">원격에서 사용할 수 있는 명령이 없습니다.</p> : <List strong inset>{availableCommands.map((command) => <ListItem key={command.name} title={`/${command.name}`} subtitle={`${command.description}${command.remoteMode === "terminal-only" ? " · 비상 터미널 필요" : ""}`} link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => runCommand(command) }} />)}</List>}
    </Sheet> : null}

    {panel === "model" ? <Sheet returnFocus={sheetOpener.current} title="모델과 추론" onClose={() => setPanel(null)}>
      {actionError ? <SheetNotice error>{actionError}</SheetNotice> : null}
      <p className="sheet-section-label">모델</p>
      <List strong inset>{displayedModelChoices(summary.model).map((choice) => {
        const selected = currentModel(choice.provider, choice.modelId)
        return <ListItem key={`${choice.provider}/${choice.modelId}`} title={choice.label} subtitle={choice.description} after={selected ? "현재 선택" : undefined} link linkComponent="button" chevron={false} menuListItem menuListItemActive={selected} linkProps={{ type: "button", "aria-current": selected ? "true" : undefined, onClick: () => void fire("model.set", { provider: choice.provider, modelId: choice.modelId }, choice.changed) }} />
      })}</List>
      <BlockTitle>추론 강도</BlockTitle>
      <List strong inset>{EFFORT_CHOICES.map((choice) => {
        const selected = currentEffort(choice.level)
        return <ListItem key={choice.level} title={choice.label} after={selected ? "현재 선택" : undefined} link linkComponent="button" chevron={false} menuListItem menuListItemActive={selected} linkProps={{ type: "button", "aria-current": selected ? "true" : undefined, onClick: () => void fire("thinking.set", { level: choice.level }, `${choice.label}으로 바꿨습니다.`) }} />
      })}</List>
    </Sheet> : null}

    {panel === "compact" ? <Sheet returnFocus={sheetOpener.current} title="대화 정리" description="오래된 대화를 요약해 문맥 공간을 확보합니다." onClose={() => setPanel(null)}>
      <div className="sheet-info-card"><AppIcon name="compress" size={22} /><div><strong>현재 작업과 파일은 유지됩니다.</strong><p>정리 뒤에도 같은 세션과 대화 가지에서 이어집니다.</p></div></div>
      <label className="field"><span className="field-label">반드시 남길 내용 (선택)</span><input className="input" id="compact-instructions" placeholder="예: 접근성 결정은 모두 유지" /></label>
      <div className="sheet-actions"><Button outline onClick={() => setPanel(null)}>취소</Button><Button onClick={() => { const instructions = (document.getElementById("compact-instructions") as HTMLInputElement).value; void fire("session.compact", instructions ? { instructions } : {}, "대화 정리를 시작했습니다.") }}>정리 시작</Button></div>
    </Sheet> : null}

    {panel === "tree" ? <Sheet returnFocus={sheetOpener.current} title="대화 가지" description="이전 지점을 골라 그 위치에서 다시 이어갑니다." onClose={() => setPanel(null)}>
      <List strong inset>{snapshot.data!.tree.map((node) => <ListItem key={node.id} title={node.label} subtitle={node.current ? "현재 위치" : "이 위치에서 이어가기"} after={node.current ? "현재" : undefined} link linkComponent="button" chevron={false} linkProps={{ type: "button", onClick: () => void fire("session.navigate", { targetEntryId: node.id }, `${node.label}(으)로 이동했습니다.`) }} />)}</List>
    </Sheet> : null}

    {panel === "team" ? <Sheet returnFocus={sheetOpener.current} title="하위 작업" description="주 작업과 별도로 진행되는 팀·백그라운드 상태입니다." onClose={() => setPanel(null)}>
      <div className="team-metrics"><div><span>진행 중</span><strong>{summary.teams.runningMemberCount}</strong></div><div><span>활성 실행</span><strong>{summary.teams.activeRunCount}</strong></div><div className={summary.teams.failedMemberCount > 0 ? "team-metric-failed" : ""}><span>실패</span><strong>{summary.teams.failedMemberCount}</strong></div></div>
      {summary.background.labels.length > 0 ? <List strong inset>{summary.background.labels.map((label) => <ListItem key={label} title={label === "tests" ? "테스트 실행" : label === "indexing" ? "파일 인덱싱" : label} />)}</List> : <p className="sheet-empty-copy">표시할 백그라운드 작업이 없습니다.</p>}
    </Sheet> : null}

    {panel === "artifacts" ? <Sheet returnFocus={sheetOpener.current} title="파일과 변경점" description="세션에서 만든 변경과 이미지를 확인합니다." onClose={() => setPanel(null)}>
      <Suspense fallback={<div className="skeleton" aria-label="변경점을 불러오는 중" />}><ArtifactBrowser host={host} liveSessionId={liveSessionId} images={conversation.entries.filter((entry): entry is Extract<ConversationEntry, { kind: "image" }> => entry.kind === "image")} /></Suspense>
    </Sheet> : null}

    {panel === "terminal" ? <Sheet returnFocus={sheetOpener.current} title="비상 터미널" description="구조화된 화면에서 처리할 수 없는 작업에만 사용하세요." onClose={() => setPanel(null)}>
      <Suspense fallback={<div className="skeleton" aria-label="터미널을 여는 중" />}><EmergencyTerminal host={host} liveSessionId={liveSessionId} fontSize={preferences.terminalFontSize} onClose={() => setPanel(null)} /></Suspense>
    </Sheet> : null}
  </Shell>
}
