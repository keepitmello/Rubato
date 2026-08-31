import { App as KonstaApp } from "konsta/react"
import { useEffect, useState } from "react"
import { listRegisteredHosts } from "./lib/registry"
import { useRoute } from "./lib/router"
import { useAppStore } from "./lib/store"
import { InventoryScreen } from "./screens/InventoryScreen"
import { NewSessionScreen } from "./screens/NewSessionScreen"
import { SessionScreen } from "./screens/SessionScreen"
import { SettingsScreen } from "./screens/SettingsScreen"

export function App() {
  const route = useRoute()
  const setHosts = useAppStore((state) => state.setHosts)
  const preferences = useAppStore((state) => state.preferences)
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => { void listRegisteredHosts().then(setHosts) }, [setHosts])
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.darkMode === "system" ? "" : preferences.darkMode
    document.documentElement.dataset.reducedTransparency = String(preferences.reducedTransparency)
  }, [preferences.darkMode, preferences.reducedTransparency])
  useEffect(() => {
    if (!("serviceWorker" in navigator) || import.meta.env.DEV || new URLSearchParams(location.search).has("fixture")) return
    void navigator.serviceWorker.register("/rubato/sw.js", { scope: "/rubato/" }).then((registration) => {
      if (registration.waiting) setUpdateReady(true)
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => { if (registration.waiting) setUpdateReady(true) }))
    })
  }, [])
  return <KonstaApp theme="ios" safeAreas>
    {route.name === "inventory" ? <InventoryScreen /> : null}
    {route.name === "new" ? <NewSessionScreen /> : null}
    {route.name === "settings" ? <SettingsScreen /> : null}
    {route.name === "session" ? <SessionScreen hostId={route.hostId} liveSessionId={route.liveSessionId} /> : null}
    {updateReady ? <div className="state-banner" role="status" style={{ position: "fixed", left: 0, right: 0, top: "calc(56px + env(safe-area-inset-top))", bottom: "auto", zIndex: 80 }}>새 버전을 사용할 수 있어요. <button className="text-button" onClick={() => { navigator.serviceWorker.controller?.postMessage({ type: "SKIP_WAITING" }); location.reload() }}>지금 업데이트</button></div> : null}
  </KonstaApp>
}
