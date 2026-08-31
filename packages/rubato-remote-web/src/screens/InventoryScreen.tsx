import { useQuery } from "@tanstack/react-query"
import type { LiveSessionSummary } from "@rubato/remote-protocol"
import { Badge } from "konsta/react"
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

function SessionCard({ session, primary }: { session: LiveSessionSummary; primary: boolean }) {
  const secondary = session.background.activeCount > 0 ? ` · 하위 작업 ${session.background.activeCount}개 진행 중` : ""
  return <button className={`session-card ${primary ? "primary-session" : ""}`} onClick={() => navigate(`/session/${session.hostId}/${session.liveSessionId}`)}>
    <div className="row spread">
      <span className="session-title">{session.title}</span>
      {session.attention ? <Badge colors={{ bg: "bg-amber-500" }}>확인 필요</Badge> : null}
    </div>
    <div className="meta path">{session.cwd.replace(/^\/Users\/[^/]+/, "~")}</div>
    <div className="row spread" style={{ marginTop: 10 }}>
      <span className="status"><span className={`status-dot ${session.attention ? "attention" : session.execution}`} />{session.execution === "working" ? "작업 중" : "대기"}{secondary}</span>
      <span className={primary ? "continue-label" : "meta"}>{primary ? "이어가기 →" : relativeTime(session.lastAssistantAt)}</span>
    </div>
  </button>
}

function HostGroup({ inventory, hasPrimary }: { inventory: HostInventory; hasPrimary: boolean }) {
  return <section aria-labelledby={`host-${inventory.host.hostId}`}>
    <div className="row spread section-title">
      <span id={`host-${inventory.host.hostId}`}>{inventory.host.displayName}</span>
      <span className="status"><span className={`status-dot ${inventory.connection === "online" ? "working" : "offline"}`} />{inventory.connection === "online" ? "연결됨" : inventory.connection === "connecting" ? "연결 중" : inventory.connection === "incompatible" ? "업데이트 필요" : inventory.connection === "denied" ? "접근 거부" : "오프라인"}</span>
    </div>
    {inventory.sessions.length > 0 ? <div className="surface">{inventory.sessions.map((session, index) => <SessionCard key={session.liveSessionId} session={session} primary={!hasPrimary && index === 0} />)}</div> : <div className="surface empty"><div className="empty-mark" aria-hidden="true">{inventory.connection === "online" ? "＋" : "⌁"}</div><strong>{inventory.connection === "online" ? "실행 중인 세션이 없어요" : "이 Mac은 지금 오프라인이에요"}</strong><div className="meta" style={{ marginTop: 6 }}>{inventory.problem ?? "새 세션을 만들면 여기에 나타납니다."}</div></div>}
  </section>
}

export function InventoryScreen() {
  const hosts = useAppStore((state) => state.hosts)
  const inventory = useQuery({ queryKey: ["inventory", hosts], queryFn: () => fetchInventory(hosts), refetchInterval: 10_000 })
  const allOffline = inventory.data?.every((host) => host.connection !== "online")
  const hasSessions = Boolean(inventory.data?.some((host) => host.sessions.length > 0))
  return <Shell title="Rubato" action={<button className="icon-button" aria-label="설정 열기" onClick={() => navigate("/settings")}>⚙︎</button>}>
    {(!navigator.onLine || allOffline) ? <StateBanner>저장된 세션을 보고 있어요. 연결되면 자동으로 새로 고칩니다.</StateBanner> : null}
    <main className="content">
      <div className="eyebrow">Live work</div>
      <h1 className="hero-title">어디서든 같은 작업을<br />이어가세요.</h1>
      <p className="hero-copy">Mac에서 실행 중인 Rubato를 확인하고, 같은 대화를 휴대폰에서 계속할 수 있습니다.</p>
      {inventory.isLoading ? <LoadingCards /> : inventory.isError ? <div className="surface error-box" role="alert"><strong>세션을 불러오지 못했어요.</strong><p>기존 내용은 그대로입니다. 연결을 확인한 뒤 다시 시도하세요.</p><button className="secondary" onClick={() => void inventory.refetch()}>다시 시도</button></div> : inventory.data?.length === 0 ? <div className="surface empty"><div className="empty-mark" aria-hidden="true">⌁</div><strong>먼저 Mac을 연결하세요.</strong><p className="meta">Mac에서 만든 일회용 연결 코드가 필요합니다.</p></div> : inventory.data?.map((host, index) => <HostGroup key={host.host.hostId} inventory={host} hasPrimary={inventory.data!.slice(0, index).some((earlier) => earlier.sessions.length > 0)} />)}
    </main>
    <div className="fixed-action"><button className={inventory.data?.length === 0 || !hasSessions ? "primary" : "secondary inventory-secondary"} onClick={() => navigate(inventory.data?.length === 0 ? "/settings" : "/new")}>{inventory.data?.length === 0 ? "Mac 연결" : "새 세션"}</button></div>
  </Shell>
}
