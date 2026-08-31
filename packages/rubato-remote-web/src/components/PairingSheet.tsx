import type { PairingQrPayload } from "@rubato/remote-protocol"
import { Button, Card } from "konsta/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { pairingPayloadExpired, parsePairingQrText } from "../lib/pairing-link"
import { Sheet } from "./Shell"

export interface CameraScanner {
  stop(): void
}

export type CameraScannerFactory = (
  video: HTMLVideoElement,
  onResult: (text: string) => void,
) => Promise<CameraScanner>

export async function createCameraScanner(video: HTMLVideoElement, onResult: (text: string) => void): Promise<CameraScanner> {
  const { BrowserQRCodeReader } = await import("@zxing/browser")
  const reader = new BrowserQRCodeReader(undefined, {
    delayBetweenScanAttempts: 200,
    delayBetweenScanSuccess: 1_000,
  })
  const controls = await reader.decodeFromConstraints(
    { audio: false, video: { facingMode: { ideal: "environment" } } },
    video,
    (result) => {
      if (result) onResult(result.getText())
    },
  )
  return {
    stop() {
      controls.stop()
      const stream = video.srcObject
      if (typeof MediaStream !== "undefined" && stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop())
      video.srcObject = null
    },
  }
}

export function CameraQrScanner({
  onResult,
  createScanner = createCameraScanner,
}: {
  onResult: (text: string) => void
  createScanner?: CameraScannerFactory
}) {
  const video = useRef<HTMLVideoElement>(null)
  const scanner = useRef<CameraScanner | undefined>(undefined)
  const [problem, setProblem] = useState("")

  useEffect(() => {
    let disposed = false
    const element = video.current
    if (!element) return
    void createScanner(element, (text) => {
      if (!disposed) onResult(text)
    }).then((active) => {
      if (disposed) active.stop()
      else scanner.current = active
    }).catch((cause) => {
      const name = typeof cause === "object" && cause && "name" in cause ? String(cause.name) : ""
      if (!disposed) setProblem(name === "NotAllowedError"
        ? "카메라 권한이 꺼져 있어요. iPhone 설정에서 카메라를 허용하거나 직접 입력하세요."
        : "카메라를 시작하지 못했어요. 직접 입력하거나 다시 시도하세요.")
    })
    return () => {
      disposed = true
      scanner.current?.stop()
      scanner.current = undefined
      const stream = element.srcObject
      if (typeof MediaStream !== "undefined" && stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop())
      element.srcObject = null
    }
  }, [createScanner, onResult])

  return <div className="qr-scanner">
    <video ref={video} className="qr-video" muted playsInline aria-label="Mac 연결 QR 카메라" />
    <div className="qr-guide" aria-hidden="true" />
    <p className={problem ? "state-banner error" : "meta"} role={problem ? "alert" : "status"}>
      {problem || "Mac 터미널에 표시된 Rubato 연결 QR을 사각형 안에 맞추세요."}
    </p>
  </div>
}

type PairingMode = "choose" | "instructions" | "scan" | "manual" | "review"

export function PairingSheet({
  initial,
  onConfirm,
  onClose,
}: {
  initial?: PairingQrPayload | null
  onConfirm: (payload: Pick<PairingQrPayload, "baseUrl" | "nonce">) => Promise<void>
  onClose: () => void
}) {
  const [mode, setMode] = useState<PairingMode>(initial ? "review" : "choose")
  const [payload, setPayload] = useState<PairingQrPayload | null>(initial ?? null)
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "")
  const [nonce, setNonce] = useState(initial?.nonce ?? "")
  const [problem, setProblem] = useState("")
  const [busy, setBusy] = useState(false)

  const scanResult = useCallback((text: string) => {
    const scanned = parsePairingQrText(text)
    if (!scanned) {
      setProblem("Rubato 연결 QR이 아니거나 손상됐어요. Mac에서 새 QR을 열고 다시 찍으세요.")
      return
    }
    if (pairingPayloadExpired(scanned)) {
      setProblem("이 연결 QR은 만료됐어요. Mac에서 새 QR을 만든 뒤 다시 찍으세요.")
      return
    }
    setProblem("")
    setPayload(scanned)
    setBaseUrl(scanned.baseUrl)
    setNonce(scanned.nonce)
    setMode("review")
  }, [])

  const confirm = async () => {
    setBusy(true)
    setProblem("")
    try {
      await onConfirm({ baseUrl, nonce })
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Mac을 연결하지 못했어요.")
    } finally {
      setBusy(false)
    }
  }

  const hostname = (() => {
    try { return new URL(baseUrl).hostname }
    catch { return "Mac 주소 확인" }
  })()

  return <Sheet title="Rubato Mac 연결" hideHandle closeText="닫기" onClose={onClose}>
    {problem ? <div className="state-banner error" role="alert">{problem}</div> : null}
    {mode === "choose" ? <>
      <h3 className="pairing-question">Mac에 Rubato 연결 QR이 보이나요?</h3>
      <p className="meta">QR을 찍으면 이 iPhone의 Rubato가 Mac과 연결돼요.</p>
      <div className="pairing-actions-stack">
        <Button large onClick={() => { setProblem(""); setMode("scan") }}>네, 카메라 열기</Button>
        <Button large outline onClick={() => setMode("instructions")}>아니요, QR 여는 법 보기</Button>
      </div>
    </> : null}
    {mode === "instructions" ? <>
      <ol className="pairing-steps">
        <li><strong>Mac에서 QR 열기</strong><span>터미널에 <code>rubato remote add-host</code>를 그대로 입력하세요. 같은 창에 QR이 나타나요.</span></li>
        <li><strong>iPhone으로 찍기</strong><span>QR이 보이면 아래 버튼을 누르세요. 카메라 권한을 물으면 허용하세요.</span></li>
        <li><strong>연결 확인하기</strong><span>읽은 Mac 주소를 확인하고 <b>이 Mac 연결</b>을 누르면 끝나요.</span></li>
      </ol>
      <p className="meta">iPhone과 Mac은 같은 Tailscale 계정으로 연결돼 있어야 해요.</p>
      <p className="meta">QR과 연결 코드는 10분 뒤 만료돼요. 만료되면 Mac에서 같은 명령을 다시 실행하세요.</p>
      <Button large onClick={() => { setProblem(""); setMode("scan") }}>QR이 보이면 카메라 열기</Button>
      <button className="text-button pairing-fallback" onClick={() => { setProblem(""); setMode("manual") }}>QR 대신 터미널 아래의 주소·코드 입력</button>
      <button className="text-button pairing-fallback" onClick={() => setMode("choose")}>처음으로</button>
    </> : null}
    {mode === "scan" ? <>
      <CameraQrScanner onResult={scanResult} />
      <button className="text-button pairing-fallback" onClick={() => { setProblem(""); setMode("manual") }}>카메라 대신 직접 입력</button>
    </> : null}
    {mode === "manual" ? <>
      <p className="meta">Mac 터미널의 QR 아래에 표시된 Mac 주소와 연결 코드를 입력하세요.</p>
      <label className="field"><span className="field-label">Mac 주소</span><input className="input" inputMode="url" autoCapitalize="none" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://my-mac.example.ts.net/rubato/" /></label>
      <label className="field"><span className="field-label">연결 코드</span><input className="input" autoCapitalize="none" value={nonce} onChange={(event) => setNonce(event.target.value)} /></label>
      <Button large disabled={!baseUrl || !nonce || busy} onClick={() => void confirm()}>{busy ? "연결하는 중…" : "이 Mac 연결"}</Button>
      <button className="text-button pairing-fallback" onClick={() => { setProblem(""); setMode("scan") }}>QR이 보이면 카메라 열기</button>
    </> : null}
    {mode === "review" ? <>
      <p className="meta">QR을 읽었어요. 연결할 Mac 주소가 맞는지 확인하세요.</p>
      <Card className="pairing-review"><strong>{hostname}</strong><span>{payload?.baseUrl ?? baseUrl}</span></Card>
      <Button large disabled={busy} onClick={() => void confirm()}>{busy ? "연결하는 중…" : "이 Mac 연결"}</Button>
      <button className="text-button pairing-fallback" onClick={() => { setProblem(""); setPayload(null); setMode("scan") }}>다시 찍기</button>
    </> : null}
  </Sheet>
}
