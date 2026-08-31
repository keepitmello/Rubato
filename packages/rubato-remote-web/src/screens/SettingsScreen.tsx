import { Button, Range, Toggle } from "konsta/react"
import { useEffect, useId, useState, type ReactNode } from "react"
import { AppIcon, type AppIconName } from "../components/Icon"
import { PairingSheet } from "../components/PairingSheet"
import { Sheet, Shell } from "../components/Shell"
import { pairHost, subscribePush, synchronizePushProfile, unsubscribePush } from "../lib/api"
import { hasPairingLink, parsePairingLink } from "../lib/pairing-link"
import { exportRegisteredHosts, importRegisteredHosts, removeRegisteredHost, saveRegisteredHost } from "../lib/registry"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"

function SettingsSection({ icon, title, detail, children }: { icon: AppIconName; title: string; detail?: string; children: ReactNode }) {
  const titleId = useId()
  return <section className="settings-section" aria-labelledby={titleId}>
    <header className="section-heading settings-heading">
      <span className="section-heading-icon" aria-hidden="true"><AppIcon name={icon} size={20} /></span>
      <div><h2 id={titleId}>{title}</h2>{detail ? <p>{detail}</p> : null}</div>
    </header>
    <div className="settings-card surface">{children}</div>
  </section>
}

function SettingsRow({ icon, title, detail, trailing, danger = false }: { icon?: AppIconName; title: string; detail?: string; trailing?: ReactNode; danger?: boolean }) {
  return <div className={`settings-row ${danger ? "settings-row-danger" : ""}`}>
    {icon ? <span className="settings-row-icon" aria-hidden="true"><AppIcon name={icon} size={19} /></span> : null}
    <div className="settings-row-copy"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div>
    {trailing ? <div className="settings-row-trailing">{trailing}</div> : null}
  </div>
}

export function SettingsScreen() {
  const [initialPairing] = useState(() => parsePairingLink(location.search))
  const [openedFromPairingLink] = useState(() => hasPairingLink(location.search))
  const hosts = useAppStore((state) => state.hosts)
  const setHosts = useAppStore((state) => state.setHosts)
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  const [pairing, setPairing] = useState(openedFromPairingLink)
  const [message, setMessage] = useState(openedFromPairingLink && !initialPairing
    ? "연결 정보가 잘못됐거나 손상됐어요. Mac에서 새 연결 정보를 만드세요."
    : "")
  const [importText, setImportText] = useState("")
  const [showTransfer, setShowTransfer] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)

  useEffect(() => {
    if (!openedFromPairingLink) return
    const search = new URLSearchParams(location.search)
    search.delete("pair")
    history.replaceState(history.state, "", `${location.pathname}${search.size ? `?${search}` : ""}${location.hash}`)
  }, [openedFromPairingLink])

  const connect = async (payload: { baseUrl: string; nonce: string }) => {
    const host = await pairHost(payload)
    await saveRegisteredHost(host)
    setHosts([...hosts.filter((item) => item.hostId !== host.hostId), host])
    setPairing(false)
    navigate("/")
  }

  const requestPush = async (refresh = false) => {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setMessage("이 브라우저는 홈 화면 알림을 지원하지 않아요.")
      return
    }
    setPushBusy(true)
    try {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
      if (permission !== "granted") {
        updatePreferences({ pushEnabled: false })
        setMessage("알림 권한이 꺼져 있어요. iPhone 설정에서 다시 켤 수 있습니다.")
        return
      }
      await subscribePush(hosts, refresh)
      updatePreferences({ pushEnabled: true })
      setMessage(refresh ? "알림 구독을 새로 등록했습니다." : "작업 완료와 확인 요청을 알려드릴게요.")
    } catch (cause) {
      updatePreferences({ pushEnabled: false })
      setMessage(cause instanceof Error ? cause.message : "알림을 등록하지 못했어요.")
    } finally {
      setPushBusy(false)
    }
  }

  const syncPush = async () => {
    if (hosts.length < 2) {
      setMessage("프로필을 동기화할 다른 Mac이 없어요.")
      return
    }
    setPushBusy(true)
    try {
      await Promise.all(hosts.slice(1).map((destination) => synchronizePushProfile(hosts[0], destination)))
      setMessage(`${hosts.length}대의 Mac에 알림 프로필을 동기화했습니다.`)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "알림 프로필을 동기화하지 못했어요.")
    } finally {
      setPushBusy(false)
    }
  }

  const disconnect = async (host: typeof hosts[number]) => {
    setPushBusy(true)
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) await unsubscribePush([host], hosts.length === 1)
      await removeRegisteredHost(host.hostId)
      setHosts(hosts.filter((item) => item.hostId !== host.hostId))
      if (hosts.length === 1) updatePreferences({ pushEnabled: false })
      setMessage(`${host.displayName} 연결과 알림 등록을 해제했습니다.`)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Mac 연결을 해제하지 못했어요.")
    } finally {
      setPushBusy(false)
    }
  }

  const disablePush = async () => {
    setPushBusy(true)
    try {
      await unsubscribePush(hosts, true)
      updatePreferences({ pushEnabled: false })
      setMessage("모든 Mac과 브라우저의 알림 구독을 해제했습니다.")
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "알림 구독을 해제하지 못했어요.")
    } finally {
      setPushBusy(false)
    }
  }

  const transfer = async (mode: "export" | "import") => {
    try {
      if (mode === "import") {
        const count = await importRegisteredHosts(importText)
        setMessage(`${count}개 호스트를 가져왔습니다.`)
        location.reload()
      } else {
        setImportText(await exportRegisteredHosts())
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "호스트 목록을 처리하지 못했어요.")
    }
  }

  return <Shell title="설정" back="/" className="settings-screen">
    <main className="page-body settings-body">
      {message ? <div className="settings-notice surface" role="status"><AppIcon name="check" size={18} /><span>{message}</span></div> : null}

      <SettingsSection icon="mac" title="연결된 Mac" detail="현재 iPhone에서 제어할 수 있는 호스트입니다.">
        {hosts.length > 0 ? hosts.map((host) => <div className="host-setting" key={host.hostId}>
          <span className="host-setting-icon" aria-hidden="true"><AppIcon name="mac" size={21} /></span>
          <div className="host-setting-copy"><strong>{host.displayName}</strong><span>{host.ownerLogin}</span><small>{host.baseUrl}</small></div>
          <button className="text-button danger-text" type="button" disabled={pushBusy} onClick={() => void disconnect(host)}>연결 해제</button>
        </div>) : <div className="settings-empty"><strong>연결된 Mac이 없어요.</strong><span>Mac에서 만든 10분짜리 연결 정보를 사용하세요.</span></div>}
        <div className="settings-card-action"><Button large onClick={() => setPairing(true)}><span className="button-label"><AppIcon name="link" size={19} />Mac 연결</span></Button></div>
      </SettingsSection>

      <SettingsSection icon="bell" title="알림" detail="앱을 닫아도 중요한 상태만 알려드립니다.">
        <SettingsRow
          icon="bell"
          title="작업 알림"
          detail="완료되거나 확인이 필요할 때"
          trailing={<Button small outline disabled={pushBusy} onClick={() => void requestPush(false)}>{preferences.pushEnabled ? "등록됨" : "알림 켜기"}</Button>}
        />
        {preferences.pushEnabled ? <>
          <SettingsRow icon="refresh" title="구독 새로 등록" detail="키가 바뀌었거나 알림이 오지 않을 때" trailing={<button className="text-button" type="button" disabled={pushBusy} onClick={() => void requestPush(true)}>새로 등록</button>} />
          <SettingsRow icon="network" title="Mac 간 프로필 동기화" detail="연결된 모든 Mac에서 같은 알림 사용" trailing={<button className="text-button" type="button" disabled={pushBusy || hosts.length < 2} onClick={() => void syncPush()}>동기화</button>} />
          <SettingsRow icon="trash" title="알림 구독 해제" detail="모든 Mac과 이 브라우저에서 제거" danger trailing={<button className="text-button danger-text" type="button" disabled={pushBusy} onClick={() => void disablePush()}>알림 끄기</button>} />
        </> : null}
      </SettingsSection>

      <SettingsSection icon="appearance" title="화면" detail="시스템 모양과 접근성 설정을 따릅니다.">
        <SettingsRow icon="appearance" title="모양" detail="iPhone 설정을 따르거나 직접 선택" trailing={<select className="input compact-select" value={preferences.darkMode} onChange={(event) => updatePreferences({ darkMode: event.target.value as "system" | "light" | "dark" })} aria-label="모양"><option value="system">시스템</option><option value="light">밝게</option><option value="dark">어둡게</option></select>} />
        <SettingsRow icon="appearance" title="투명 효과 줄이기" detail="유리 효과 대신 읽기 쉬운 단색 사용" trailing={<Toggle checked={preferences.reducedTransparency} onChange={() => updatePreferences({ reducedTransparency: !preferences.reducedTransparency })} aria-label="투명 효과 줄이기" />} />
        <div className="settings-range-row">
          <div className="settings-range-heading"><span><AppIcon name="terminal" size={19} /><strong>터미널 글자 크기</strong></span><output>{preferences.terminalFontSize}px</output></div>
          <Range min={12} max={22} value={preferences.terminalFontSize} onChange={(event) => updatePreferences({ terminalFontSize: Number((event.target as HTMLInputElement).value) })} aria-label="터미널 글자 크기" />
        </div>
      </SettingsSection>

      <SettingsSection icon="star" title="즐겨찾기" detail="새 세션에서 바로 선택할 작업 폴더입니다.">
        {preferences.favorites.length
          ? preferences.favorites.map((path) => <SettingsRow key={path} icon="folder" title={path.split("/").at(-1) ?? path} detail={path} />)
          : <div className="settings-empty"><strong>즐겨찾기가 없어요.</strong><span>새 세션을 만들 때 폴더를 즐겨찾기에 추가할 수 있습니다.</span></div>}
      </SettingsSection>

      <SettingsSection icon="diagnostics" title="복구와 진단" detail="연결 정보를 옮기거나 현재 상태를 확인합니다.">
        <button className="settings-action-row" type="button" onClick={() => setShowTransfer(true)}>
          <span className="settings-row-icon" aria-hidden="true"><AppIcon name="download" size={19} /></span>
          <span className="settings-row-copy"><strong>호스트 목록 복구</strong><span>호스트 목록 내보내기 또는 가져오기</span></span>
          <AppIcon name="chevron-right" size={18} />
        </button>
        <SettingsRow icon={navigator.onLine ? "network" : "offline"} title="연결 상태" detail={`${navigator.onLine ? "네트워크 사용 가능" : "오프라인"} · 프로토콜 버전 1`} />
      </SettingsSection>
    </main>

    {pairing ? <PairingSheet initial={initialPairing} onClose={() => setPairing(false)} onConfirm={connect} /> : null}
    {showTransfer ? <Sheet title="호스트 목록 복구" description="다른 기기에서 내보낸 목록을 안전하게 옮깁니다." onClose={() => setShowTransfer(false)}>
      <label className="field"><span className="field-label">내보낸 호스트 목록</span><textarea className="input transfer-textarea" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="내보내기를 누르거나 이전 목록을 붙여 넣으세요." /></label>
      <div className="sheet-actions"><Button large outline onClick={() => void transfer("export")}><span className="button-label"><AppIcon name="upload" size={18} />내보내기</span></Button><Button large disabled={!importText.trim()} onClick={() => void transfer("import")}><span className="button-label"><AppIcon name="download" size={18} />가져오기</span></Button></div>
    </Sheet> : null}
  </Shell>
}
