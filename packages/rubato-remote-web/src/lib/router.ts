import { useEffect, useState } from "react"

export type Route =
  | { name: "inventory" }
  | { name: "new" }
  | { name: "session"; hostId: string; liveSessionId: string }
  | { name: "settings" }

export function parseRoute(pathname: string, search = ""): Route {
  if (new URLSearchParams(search).has("pair")) return { name: "settings" }
  const path = pathname.replace(/^\/rubato\/?/, "/")
  if (path === "/new") return { name: "new" }
  if (path === "/settings") return { name: "settings" }
  const session = path.match(/^\/session\/([^/]+)\/([^/]+)\/?$/)
  if (session) return { name: "session", hostId: decodeURIComponent(session[1]), liveSessionId: decodeURIComponent(session[2]) }
  return { name: "inventory" }
}

export function navigate(path: string): void {
  const fullPath = `/rubato${path === "/" ? "/" : path}`
  history.pushState(null, "", fullPath + location.search)
  dispatchEvent(new PopStateEvent("popstate"))
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname, location.search))
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname, location.search))
    addEventListener("popstate", update)
    return () => removeEventListener("popstate", update)
  }, [])
  return route
}
