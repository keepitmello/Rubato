import "@xterm/xterm/css/xterm.css"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { useEffect, useRef, useState } from "react"
import { connectTerminal, type TerminalConnection } from "../lib/api"
import type { RegisteredHost } from "../lib/types"

export default function EmergencyTerminal({ host, liveSessionId, fontSize, onClose }: { host: RegisteredHost; liveSessionId: string; fontSize: number; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | undefined>(undefined)
  const connection = useRef<TerminalConnection | undefined>(undefined)
  const [screenReader, setScreenReader] = useState(false)
  const [status, setStatus] = useState("현재 세션에 연결하는 중…")

  useEffect(() => {
    if (!root.current) return
    let disposed = false
    const instance = new Terminal({ fontSize, cursorBlink: true, scrollback: 2_000, screenReaderMode: screenReader, theme: { background: "#090c12", foreground: "#e7ebf3" } })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(root.current)
    fit.fit()
    terminal.current = instance
    const data = instance.onData((value) => connection.current?.sendInput(value))
    const resized = instance.onResize(({ cols, rows }) => connection.current?.resize(cols, rows))
    void connectTerminal(host, liveSessionId, {
      output: (value) => { if (!disposed) { instance.write(value); setStatus("현재 세션에 연결됨") } },
      exit: () => { if (!disposed) setStatus("터미널 연결이 끝났어요.") },
      error: (message) => { if (!disposed) { instance.writeln(`\r\n${message}`); setStatus("터미널 연결 오류") } },
    }).then((transport) => {
      if (disposed) transport.close()
      else { connection.current = transport; transport.resize(instance.cols, instance.rows); instance.focus() }
    }).catch((cause) => { if (!disposed) setStatus(cause instanceof Error ? cause.message : "터미널에 연결하지 못했어요.") })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(root.current)
    return () => {
      disposed = true
      observer.disconnect(); data.dispose(); resized.dispose(); connection.current?.close(); connection.current = undefined
      instance.dispose(); terminal.current = undefined
    }
  }, [fontSize, host, liveSessionId, screenReader])

  const key = (value: string) => { terminal.current?.focus(); connection.current?.sendInput(value) }
  const close = () => { connection.current?.close(); onClose() }
  return <>
    <p className="meta">지원되지 않는 설정 화면이나 복구 작업에만 사용하세요. 닫아도 Rubato 작업은 계속됩니다.</p>
    <div className="row spread"><label className="row"><input type="checkbox" checked={screenReader} onChange={(event) => setScreenReader(event.target.checked)} /> 화면 읽기 모드</label><span className="meta" role="status">{status}</span></div>
    <div className="terminal-wrap"><div ref={root} className="terminal" aria-label="터미널 화면" /></div>
    <div className="key-row" aria-label="터미널 보조 키">
      <button onClick={() => key("\u001b")}>Esc</button><button onClick={() => key("\u0003")}>Ctrl</button><button onClick={() => key("\t")}>Tab</button>
      <button onClick={() => key("\u001b[A")} aria-label="위쪽 화살표">↑</button><button onClick={() => key("\u001b[B")} aria-label="아래쪽 화살표">↓</button><button onClick={() => key("\u001b[D")} aria-label="왼쪽 화살표">←</button><button onClick={() => key("\u001b[C")} aria-label="오른쪽 화살표">→</button>
      <button onClick={() => terminal.current?.scrollPages(-1)}>PgUp</button><button onClick={() => terminal.current?.scrollPages(1)}>PgDn</button><button onClick={() => navigator.clipboard.readText().then((value) => key(value))}>붙여넣기</button>
    </div>
    <button className="primary" onClick={close}>터미널 닫기</button>
  </>
}
