import { useQuery } from "@tanstack/react-query"
import type { LiveSessionSummary } from "@rubato/remote-protocol"
import { Button, Toolbar, ToolbarPane } from "konsta/react"
import { AppIcon } from "../components/Icon"
import { EmptyState, LoadingCards, Shell, StateBanner } from "../components/Shell"
import { fetchInventory } from "../lib/api"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import type { HostInventory } from "../lib/types"

function relativeTime(value?: string): string {
  if (!value) return "아직 응답 없음"
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 15) return "방금 응답"
  if (seconds < 60) return `${seconds}초 전 응답`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전 응답`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전 응답`
  return `${Math.floor(hours / 24)}일 전 응답`
}

function connectionLabel(connection: HostInventory["connection"]): string {
  if (connection === "online") return "연결됨"
  if (connection === "connecting") return "연결 중"
  if (connection === "incompatible") return "업데이트 필요"
  if (connection === "denied") return "접근 거부"
  return "오프라인"
}

function sessionStatus(session: LiveSessionSummary): string {
  const primary = session.execution === "working" ? "작업 중" : "대기"
  if (session.attention) return `${primary} · 확인 필요`
  if (session.background.activeCount > 0) return `${primary} · 하위 작업 ${session.background.activeCount}개 진행 중`
  return primary
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~")
}

function SessionCard({ session, primary }: { session: LiveSessionSummary; primary: boolean }) {
  const working = session.execution === "working"
  const status = sessionStatus(session)
  const metadata = [session.model.label, relativeTime(session.lastAssistantAt)].filter(Boolean).join(" · ")

  return <button
    type="button"
    className={`session-card ${working ? "session-card-working" : ""} ${session.attention ? "session-card-attention" : ""}`.trim()}
    onClick={() => navigate(`/session/${session.hostId}/${session.liveSessionId}`)}
  >
    <span className="session-card-icon" aria-hidden="true"><AppIcon name={working ? "spark" : "clock"} size={21} /></span>
    <span className="session-card-body">
      <span className="session-card-title-row">
        <strong className="session-card-title">{session.title}</strong>
        {session.attention ? <span className="status-label status-label-attention">확인 필요</span> : primary ? <span className="status-label status-label-primary">이어가기</span> : null}
      </span>
      <span className="session-card-status"><span className={`status-dot ${working ? "working" : "idle"}`} />{status}</span>
      <span className="session-card-path">{shortPath(session.cwd)}</span>
      <span className="session-card-meta">{metadata}</span>
    </span>
    <span className="session-card-chevron" aria-hidden="true"><AppIcon name="chevron-right" size={19} /></span>
  </button>
}

function HostGroup({ inventory, hasPrimary }: { inventory: HostInventory; hasPrimary: boolean }) {
  return <section className="host-group" aria-labelledby={`host-${inventory.host.hostId}`}>
    <header className="section-heading host-heading">
      <div>
        <p className="section-kicker">Mac</p>
        <h2 id={`host-${inventory.host.hostId}`}>{inventory.host.displayName}</h2>
      </div>
      <span className={`connection-pill connection-${inventory.connection}`}>
        <span className={`status-dot ${inventory.connection === "online" ? "working" : "offline"}`} />
        {connectionLabel(inventory.connection)}
      </span>
    </header>

    {inventory.sessions.length > 0
      ? <div className="session-card-list">{inventory.sessions.map((session, index) => <SessionCard key={session.liveSessionId} session={session} primary={!hasPrimary && index === 0} />)}</div>
      : <EmptyState
          icon={inventory.connection === "online" ? "plus" : "offline"}
          title={inventory.connection === "online" ? "실행 중인 세션이 없어요" : "이 Mac은 지금 오프라인이에요"}
          detail={inventory.problem ?? "새 세션을 만들면 여기에 나타납니다."}
        />}
  </section>
}

function InventoryOverview({ inventories }: { inventories: readonly HostInventory[] }) {
  const sessions = inventories.flatMap((inventory) => inventory.sessions)
  const working = sessions.filter((session) => session.execution === "working").length
  const attention = sessions.filter((session) => session.attention).length
  const online = inventories.filter((inventory) => inventory.connection === "online").length

  return <section className="inventory-overview" aria-label="현재 상태 요약">
    <div className="overview-item"><span>작업 중</span><strong>{working}</strong></div>
    <div className="overview-divider" aria-hidden="true" />
    <div className="overview-item"><span>확인 필요</span><strong>{attention}</strong></div>
    <div className="overview-divider" aria-hidden="true" />
    <div className="overview-item"><span>연결된 Mac</span><strong>{online}</strong></div>
  </section>
}

export function InventoryScreen() {
  const hosts = useAppStore((state) => state.hosts)
  const inventory = useQuery({
    queryKey: ["inventory", hosts],
    queryFn: () => fetchInventory(hosts),
    refetchInterval: 10_000,
  })
  const allOffline = inventory.data?.every((host) => host.connection !== "online")
  const hasSessions = Boolean(inventory.data?.some((host) => host.sessions.length > 0))
  const emptyHosts = inventory.data?.length === 0
  const primaryLabel = emptyHosts ? "Mac 연결" : "새 세션"
  const primaryPath = emptyHosts ? "/settings" : "/new"

  return <Shell
    title="Rubato"
    className="inventory-screen"
    action={<button className="icon-button navbar-icon-button" type="button" aria-label="설정 열기" onClick={() => navigate("/settings")}><AppIcon name="settings" size={21} /></button>}
  >
    {(!navigator.onLine || allOffline) ? <StateBanner>저장된 세션을 보고 있어요. 연결되면 자동으로 새로 고칩니다.</StateBanner> : null}
    <main className="page-body inventory-body">
      {inventory.isLoading ? <LoadingCards /> : inventory.isError
        ? <div className="surface error-box" role="alert">
            <span className="error-icon" aria-hidden="true"><AppIcon name="warning" size={24} /></span>
            <strong>세션을 불러오지 못했어요.</strong>
            <p>기존 내용은 그대로입니다. 연결을 확인한 뒤 다시 시도하세요.</p>
            <Button outline onClick={() => void inventory.refetch()}>다시 시도</Button>
          </div>
        : emptyHosts
          ? <EmptyState
              icon="link"
              title="먼저 Mac을 연결하세요"
              detail="Mac에서 만든 일회용 연결 정보가 필요합니다. 연결 후 실행 중인 세션이 여기에 모입니다."
              action={<Button outline onClick={() => navigate("/settings")}>연결 방법 보기</Button>}
            />
          : <>
              <InventoryOverview inventories={inventory.data ?? []} />
              {(inventory.data ?? []).map((host, index) => <HostGroup
                key={host.host.hostId}
                inventory={host}
                hasPrimary={(inventory.data ?? []).slice(0, index).some((earlier) => earlier.sessions.length > 0)}
              />)}
            </>}
    </main>
    <Toolbar className="toolbar-dock app-bottom-dock">
      <ToolbarPane className="toolbar-pane-fill">
        <Button className="toolbar-action" large rounded onClick={() => navigate(primaryPath)}>
          <span className="button-label"><AppIcon name={emptyHosts ? "link" : "plus"} size={20} />{primaryLabel}</span>
        </Button>
      </ToolbarPane>
    </Toolbar>
  </Shell>
}
