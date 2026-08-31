import { App as KonstaApp, Dialog, DialogButton } from "konsta/react"
import { useEffect, useLayoutEffect, useState } from "react"
import { listRegisteredHosts } from "./lib/registry"
import { useRoute } from "./lib/router"
import { useAppStore } from "./lib/store"
import { InventoryScreen } from "./screens/InventoryScreen"
import { NewSessionScreen } from "./screens/NewSessionScreen"
import { SessionScreen } from "./screens/SessionScreen"
import { SettingsScreen } from "./screens/SettingsScreen"

function systemPrefersDark() {
  return matchMedia("(prefers-color-scheme: dark)").matches
}

function resolveDark(darkMode: "system" | "light" | "dark", systemDark: boolean) {
  return darkMode === "dark" || (darkMode === "system" && systemDark)
}

function applyAppearance(dark: boolean, darkMode: "system" | "light" | "dark", reducedTransparency: boolean) {
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.dataset.theme = darkMode === "system" ? "" : darkMode
  document.documentElement.dataset.reducedTransparency = String(reducedTransparency)
  if (darkMode === "system") document.documentElement.style.removeProperty("color-scheme")
  else document.documentElement.style.colorScheme = darkMode
}

export function App() {
  const route = useRoute()
  const setHosts = useAppStore((state) => state.setHosts)
  const preferences = useAppStore((state) => state.preferences)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const [updateReady, setUpdateReady] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null)
  const dark = resolveDark(preferences.darkMode, systemDark)
  useEffect(() => { void listRegisteredHosts().then(setHosts) }, [setHosts])
  useLayoutEffect(() => {
    applyAppearance(dark, preferences.darkMode, preferences.reducedTransparency)
  }, [dark, preferences.darkMode, preferences.reducedTransparency])
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setSystemDark(media.matches)
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])
  useEffect(() => {
    if (!("serviceWorker" in navigator) || import.meta.env.DEV || new URLSearchParams(location.search).has("fixture")) return
    void navigator.serviceWorker.register("/rubato/sw.js", { scope: "/rubato/" }).then((registration) => {
      const showWaitingUpdate = () => {
        if (!registration.waiting) return
        setWaitingWorker(registration.waiting)
        setUpdateReady(true)
      }
      showWaitingUpdate()
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", showWaitingUpdate))
    })
  }, [])
  const applyUpdate = () => {
    if (!waitingWorker) { setUpdateReady(false); return }
    setUpdating(true)
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true })
    waitingWorker.postMessage({ type: "SKIP_WAITING" })
  }
  return <KonstaApp theme="ios" dark={dark} safeAreas>
    {route.name === "inventory" ? <InventoryScreen /> : null}
    {route.name === "new" ? <NewSessionScreen /> : null}
    {route.name === "settings" ? <SettingsScreen /> : null}
    {route.name === "session" ? <SessionScreen hostId={route.hostId} liveSessionId={route.liveSessionId} /> : null}
    <Dialog opened={updateReady} title="새 버전" content="새 버전을 사용할 수 있어요." buttons={<DialogButton strong disabled={updating} onClick={applyUpdate}>{updating ? "업데이트 중…" : "지금 업데이트"}</DialogButton>} />
  </KonstaApp>
}
