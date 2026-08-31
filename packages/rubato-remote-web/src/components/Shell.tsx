import { Glass, Page } from "konsta/react"
import { useEffect, useId, useRef, type ReactNode } from "react"
import { navigate } from "../lib/router"

export function Shell({ title, back, onBack, action, children }: { title: string; back?: string; onBack?: () => void; action?: ReactNode; children: ReactNode }) {
  return <Page className="app-page">
    <Glass className="glass-nav">
      <header className="nav-inner">
        <div className="nav-side">{back || onBack ? <button className="text-button" data-sheet-focus-fallback onClick={onBack ?? (() => navigate(back!))} aria-label="뒤로 가기">‹ 뒤로</button> : null}</div>
        <div className="nav-title">{title}</div>
        <div className="nav-side">{action}</div>
      </header>
    </Glass>
    {children}
  </Page>
}

export function StateBanner({ kind = "offline", children }: { kind?: "offline" | "error"; children: ReactNode }) {
  return <div className={`state-banner ${kind === "error" ? "error" : ""}`} role={kind === "error" ? "alert" : "status"}>{children}</div>
}

let openSheetCount = 0
let sheetReturnFocus: HTMLElement | null = null

export function Sheet({ title, onClose, returnFocus, children }: { title: string; onClose: () => void; returnFocus?: HTMLElement | null; children: ReactNode }) {
  const overlay = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  onCloseRef.current = onClose
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (returnFocus?.isConnected) sheetReturnFocus = returnFocus
    else if (openSheetCount === 0 && active && active !== document.body && !active.closest('[role="dialog"]')) sheetReturnFocus = active
    else if (openSheetCount === 0 && !active?.closest('[role="dialog"]')) sheetReturnFocus = null
    openSheetCount += 1
    const layer = overlay.current
    const siblings = layer?.parentElement ? [...layer.parentElement.children].filter((element) => element !== layer) as HTMLElement[] : []
    const previousStates = siblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }))
    for (const element of siblings) { element.inert = true; element.setAttribute("aria-hidden", "true") }
    closeButton.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== "Tab" || !layer) return
      const focusable = [...layer.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) { event.preventDefault(); return }
      const first = focusable[0]; const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    addEventListener("keydown", keyboard)
    return () => {
      removeEventListener("keydown", keyboard)
      for (const state of previousStates) { state.element.inert = state.inert; if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden"); else state.element.setAttribute("aria-hidden", state.ariaHidden) }
      openSheetCount -= 1
      queueMicrotask(() => {
        if (openSheetCount !== 0) return
        const fallback = document.querySelector<HTMLElement>("[data-sheet-focus-fallback]")
          ?? [...document.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].find((element) => !element.closest('[role="dialog"]') && !element.closest('[inert]'))
        const target = sheetReturnFocus?.isConnected ? sheetReturnFocus : fallback
        target?.focus()
      })
    }
  }, [])
  return <div ref={overlay} className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="sheet-handle" aria-hidden="true" />
      <div className="row spread"><span aria-hidden="true" style={{ width: 44 }} /><h2 className="sheet-title" id={titleId}>{title}</h2><button ref={closeButton} className="icon-button" aria-label={`${title} 닫기`} onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>
}

export function LoadingCards() {
  return <div aria-busy="true" aria-label="세션을 불러오는 중"><div className="skeleton" /><div className="skeleton" /></div>
}
