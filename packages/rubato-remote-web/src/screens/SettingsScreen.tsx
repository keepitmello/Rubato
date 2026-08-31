import { useEffect, useState } from "react"
import { pairHost, subscribePush, synchronizePushProfile, unsubscribePush } from "../lib/api"
import { hasPairingLink, parsePairingLink } from "../lib/pairing-link"
import { exportRegisteredHosts, importRegisteredHosts, removeRegisteredHost, saveRegisteredHost } from "../lib/registry"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import { Sheet, Shell } from "../components/Shell"

export function SettingsScreen() {
  const [initialPairing] = useState(() => parsePairingLink(location.search))
  const [openedFromPairingLink] = useState(() => hasPairingLink(location.search))
  const hosts = useAppStore((state) => state.hosts)
  const setHosts = useAppStore((state) => state.setHosts)
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  const [pairing, setPairing] = useState(openedFromPairingLink)
  const [baseUrl, setBaseUrl] = useState(initialPairing?.baseUrl ?? "")
  const [nonce, setNonce] = useState(initialPairing?.nonce ?? "")
  const [message, setMessage] = useState(openedFromPairingLink && !initialPairing ? "연결 정보가 잘못됐거나 손상됐어요. Mac에서 새 연결 정보를 만드세요." : "")
  const [importText, setImportText] = useState("")
  const [showTransfer, setShowTransfer] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  useEffect(() => {
    if (!openedFromPairingLink) return
    const search = new URLSearchParams(location.search)
    search.delete("pair")
    history.replaceState(history.state, "", `${location.pathname}${search.size ? `?${search}` : ""}${location.hash}`)
  }, [openedFromPairingLink])
  const connect = async () => {
    try {
      const host = await pairHost({ baseUrl, nonce })
      await saveRegisteredHost(host)
      setHosts([...hosts.filter((item) => item.hostId !== host.hostId), host])
      setPairing(false); navigate("/")
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Mac을 연결하지 못했어요.") }
  }
  const requestPush = async (refresh = false) => {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) { setMessage("이 브라우저는 홈 화면 알림을 지원하지 않아요."); return }
    setPushBusy(true)
    try {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
      if (permission !== "granted") { updatePreferences({ pushEnabled: false }); setMessage("알림 권한이 꺼져 있어요. iPhone 설정에서 다시 켤 수 있습니다."); return }
      await subscribePush(hosts, refresh)
      updatePreferences({ pushEnabled: true })
      setMessage(refresh ? "알림 구독을 새로 등록했습니다." : "작업 완료와 확인 요청을 알려드릴게요.")
    } catch (cause) { updatePreferences({ pushEnabled: false }); setMessage(cause instanceof Error ? cause.message : "알림을 등록하지 못했어요.") }
    finally { setPushBusy(false) }
  }
  const syncPush = async () => {
    if (hosts.length < 2) { setMessage("프로필을 동기화할 다른 Mac이 없어요."); return }
    setPushBusy(true)
    try { await Promise.all(hosts.slice(1).map((destination) => synchronizePushProfile(hosts[0], destination))); setMessage(`${hosts.length}대의 Mac에 알림 프로필을 동기화했습니다.`) }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "알림 프로필을 동기화하지 못했어요.") }
    finally { setPushBusy(false) }
  }
  const disconnect = async (host: typeof hosts[number]) => {
    setPushBusy(true)
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) await unsubscribePush([host], hosts.length === 1)
      await removeRegisteredHost(host.hostId)
      setHosts(hosts.filter((item) => item.hostId !== host.hostId))
      if (hosts.length === 1) updatePreferences({ pushEnabled: false })
      setMessage(`${host.displayName} 연결과 알림 등록을 해제했습니다.`)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Mac 연결을 해제하지 못했어요.") }
    finally { setPushBusy(false) }
  }
  const disablePush = async () => {
    setPushBusy(true)
    try { await unsubscribePush(hosts, true); updatePreferences({ pushEnabled: false }); setMessage("모든 Mac과 브라우저의 알림 구독을 해제했습니다.") }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "알림 구독을 해제하지 못했어요.") }
    finally { setPushBusy(false) }
  }
  const transfer = async (mode: "export" | "import") => {
    try {
      if (mode === "import") { const count = await importRegisteredHosts(importText); setMessage(`${count}개 호스트를 가져왔습니다.`); location.reload() }
      else { setImportText(await exportRegisteredHosts()) }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "호스트 목록을 처리하지 못했어요.") }
  }
  return <Shell title="설정" back="/">
    <main className="content">
      {message ? <div role="status" className="surface" style={{ padding: 14, marginBottom: 14 }}>{message}</div> : null}
      <div className="section-title">연결된 Mac</div>
      <div className="surface">{hosts.length > 0 ? hosts.map((host) => <div className="settings-row row spread" key={host.hostId}><div><strong>{host.displayName}</strong><div className="meta">{host.ownerLogin}</div></div><button className="text-button" disabled={pushBusy} onClick={() => void disconnect(host)}>연결 해제</button></div>) : <div className="empty"><strong>연결된 Mac이 없어요.</strong><p className="meta">Mac에서 만든 10분짜리 연결 정보를 사용하세요.</p></div>}</div>
      <button className="primary" style={{ marginTop: 12 }} onClick={() => setPairing(true)}>Mac 연결</button>

      <div className="section-title">알림</div>
      <div className="surface"><div className="settings-row row spread"><div><strong>작업 알림</strong><div className="meta">완료되거나 확인이 필요할 때</div></div><button className="secondary" disabled={pushBusy} onClick={() => void requestPush(false)}>{preferences.pushEnabled ? "등록됨" : "알림 켜기"}</button></div>{preferences.pushEnabled ? <><div className="settings-row row spread"><span><strong>구독 새로 등록</strong><span className="meta" style={{ display: "block" }}>키가 바뀌었거나 알림이 오지 않을 때</span></span><button className="text-button" disabled={pushBusy} onClick={() => void requestPush(true)}>새로 등록</button></div><div className="settings-row row spread"><span><strong>Mac 간 프로필 동기화</strong><span className="meta" style={{ display: "block" }}>연결된 모든 Mac에서 같은 알림 사용</span></span><button className="text-button" disabled={pushBusy || hosts.length < 2} onClick={() => void syncPush()}>동기화</button></div><div className="settings-row row spread"><span><strong>알림 구독 해제</strong><span className="meta" style={{ display: "block" }}>모든 Mac과 이 브라우저에서 제거</span></span><button className="text-button" disabled={pushBusy} onClick={() => void disablePush()}>알림 끄기</button></div></> : null}</div>

      <div className="section-title">화면</div>
      <div className="surface">
        <label className="settings-row row spread"><span><strong>모양</strong><span className="meta" style={{ display: "block" }}>iPhone 설정을 따르거나 직접 선택</span></span><select className="input" style={{ width: 120 }} value={preferences.darkMode} onChange={(event) => updatePreferences({ darkMode: event.target.value as "system" | "light" | "dark" })}><option value="system">시스템</option><option value="light">밝게</option><option value="dark">어둡게</option></select></label>
        <label className="settings-row row spread"><span><strong>투명 효과 줄이기</strong><span className="meta" style={{ display: "block" }}>유리 효과 대신 단색 사용</span></span><input className="switch" type="checkbox" checked={preferences.reducedTransparency} onChange={(event) => updatePreferences({ reducedTransparency: event.target.checked })} /></label>
        <label className="settings-row"><span className="row spread"><strong>터미널 글자 크기</strong><span>{preferences.terminalFontSize}px</span></span><input style={{ width: "100%" }} type="range" min="12" max="22" value={preferences.terminalFontSize} onChange={(event) => updatePreferences({ terminalFontSize: Number(event.target.value) })} /></label>
      </div>

      <div className="section-title">즐겨찾기</div>
      <div className="surface">{preferences.favorites.length ? preferences.favorites.map((path) => <div className="settings-row" key={path}><strong>{path.split("/").at(-1)}</strong><div className="meta path">{path}</div></div>) : <div className="empty"><strong>즐겨찾기가 없어요.</strong><p className="meta">새 세션에서 폴더를 길게 눌러 추가할 수 있습니다.</p></div>}</div>

      <div className="section-title">복구와 진단</div>
      <div className="surface"><button className="choice" onClick={() => setShowTransfer(true)}><strong>홈 호스트 주소 복구</strong><div className="meta">호스트 목록 내보내기 또는 가져오기</div></button><div className="settings-row"><strong>연결 상태</strong><div className="meta">{navigator.onLine ? "네트워크 사용 가능" : "오프라인"} · 프로토콜 버전 1</div></div></div>
    </main>
    {pairing ? <Sheet title="Mac 연결" onClose={() => setPairing(false)}><p className="meta">Mac에서 표시된 HTTPS 주소와 일회용 연결 코드를 확인하세요.</p><label className="field"><span className="field-label">Mac 주소</span><input className="input" inputMode="url" autoCapitalize="none" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://my-mac.example.ts.net/rubato/" /></label><label className="field"><span className="field-label">연결 코드</span><input className="input" autoCapitalize="none" value={nonce} onChange={(event) => setNonce(event.target.value)} /></label><button className="primary" disabled={!baseUrl || !nonce} onClick={() => void connect()}>이 Mac 연결</button></Sheet> : null}
    {showTransfer ? <Sheet title="호스트 목록 복구" onClose={() => setShowTransfer(false)}><label className="field"><span className="field-label">내보낸 호스트 목록</span><textarea className="input" style={{ minHeight: 180 }} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="내보내기를 누르거나 이전 목록을 붙여 넣으세요." /></label><div className="sheet-actions"><button className="secondary" onClick={() => void transfer("export")}>내보내기</button><button className="primary" disabled={!importText.trim()} onClick={() => void transfer("import")}>가져오기</button></div></Sheet> : null}
  </Shell>
}
