import { useQuery } from "@tanstack/react-query"
import type { LiveSessionSummary } from "@rubato/remote-protocol"
import { Badge, BlockTitle, Button, Card, List, ListItem, Toolbar, ToolbarPane } from "konsta/react"
import { fetchInventory } from "../lib/api"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import type { HostInventory } from "../lib/types"
import { LoadingCards, Shell, StateBanner } from "../components/Shell"

function relativeTime(value?: string): string {
  if (!value) return "아직 응답 없음"
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds}초 전 응답`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전 응답`
  return `${Math.floor(minutes / 60)}시간 전 응답`
}

function connectionLabel(connection: HostInventory["connection"]): string {
  if (connection === "online") return "연결됨"
  if (connection === "connecting") return "연결 중"
  if (connection === "incompatible") return "업데이트 필요"
  if (connection === "denied") return "접근 거부"
  return "오프라인"
}

function SessionRow({ session, primary }: { session: LiveSessionSummary; primary: boolean }) {
  const status = `${session.execution === "working" ? "작업 중" : "대기"}${session.background.activeCount > 0 ? ` · 하위 작업 ${session.background.activeCount}개 진행 중` : ""}`
  const cwd = session.cwd.replace(/^\/Users\/[^/]+/, "~")
  return <ListItem
    link
    chevron
    linkComponent="button"
    linkProps={{ type: "button" }}
    title={session.title}
    subtitle={status}
    footer={cwd}
    after={session.attention ? <Badge colors={{ bg: "bg-amber-500" }}>확인 필요</Badge> : primary ? <Badge className="session-primary-badge">이어가기</Badge> : relativeTime(session.lastAssistantAt)}
    onClick={() => navigate(`/session/${session.hostId}/${session.liveSessionId}`)}
  />
}

function HostGroup({ inventory, hasPrimary }: { inventory: HostInventory; hasPrimary: boolean }) {
  return <section aria-labelledby={`host-${inventory.host.hostId}`}>
    <BlockTitle>
      <span id={`host-${inventory.host.hostId}`}>{inventory.host.displayName}</span>
      <span className="status"><span className={`status-dot ${inventory.connection === "online" ? "working" : "offline"}`} />{connectionLabel(inventory.connection)}</span>
    </BlockTitle>
    {inventory.sessions.length > 0 ? <List strongIos insetIos>{inventory.sessions.map((session, index) => <SessionRow key={session.liveSessionId} session={session} primary={!hasPrimary && index === 0} />)}</List> : <Card><strong className="empty-title">{inventory.connection === "online" ? "실행 중인 세션이 없어요" : "이 Mac은 지금 오프라인이에요"}</strong><p className="empty-detail">{inventory.problem ?? "새 세션을 만들면 여기에 나타납니다."}</p></Card>}
  </section>
}

export function InventoryScreen() {
  const hosts = useAppStore((state) => state.hosts)
  const inventory = useQuery({ queryKey: ["inventory", hosts], queryFn: () => fetchInventory(hosts), refetchInterval: 10_000 })
  const allOffline = inventory.data?.every((host) => host.connection !== "online")
  const hasSessions = Boolean(inventory.data?.some((host) => host.sessions.length > 0))
  const emptyHosts = inventory.data?.length === 0
  const primaryLabel = emptyHosts ? "Mac 연결" : "새 세션"
  const primaryPath = emptyHosts ? "/settings" : "/new"
  return <Shell title="Rubato" action={<button className="icon-button" aria-label="설정 열기" onClick={() => navigate("/settings")}>⚙︎</button>}>
    {(!navigator.onLine || allOffline) ? <StateBanner>저장된 세션을 보고 있어요. 연결되면 자동으로 새로 고칩니다.</StateBanner> : null}
    <main className="page-body">
      {inventory.isLoading ? <LoadingCards /> : inventory.isError ? <Card className="error-box" role="alert"><strong>세션을 불러오지 못했어요.</strong><p>기존 내용은 그대로입니다. 연결을 확인한 뒤 다시 시도하세요.</p><Button outline onClick={() => void inventory.refetch()}>다시 시도</Button></Card> : emptyHosts ? <Card><strong className="empty-title">먼저 Mac을 연결하세요.</strong><p className="empty-detail">Mac에서 만든 일회용 연결 코드가 필요합니다.</p></Card> : inventory.data?.map((host, index) => <HostGroup key={host.host.hostId} inventory={host} hasPrimary={inventory.data!.slice(0, index).some((earlier) => earlier.sessions.length > 0)} />)}
    </main>
    <Toolbar className="toolbar-dock"><ToolbarPane className="toolbar-pane-fill"><Button className="toolbar-action" large rounded onClick={() => navigate(primaryPath)} outline={Boolean(inventory.data?.length && hasSessions)}>{primaryLabel}</Button></ToolbarPane></Toolbar>
  </Shell>
}
