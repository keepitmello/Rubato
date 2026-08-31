import { act, render, screen } from "@testing-library/react"
import { vi } from "vitest"
import { CameraQrScanner, type CameraScannerFactory } from "./PairingSheet"

describe("camera QR scanner", () => {
  test("forwards the decoded QR and stops the camera on unmount", async () => {
    const stop = vi.fn()
    let decode: ((text: string) => void) | undefined
    const createScanner: CameraScannerFactory = vi.fn(async (_video, onResult) => {
      decode = onResult
      return { stop }
    })
    const onResult = vi.fn()
    const view = render(<CameraQrScanner createScanner={createScanner} onResult={onResult} />)
    await act(async () => {})
    expect(createScanner).toHaveBeenCalledOnce()
    act(() => decode?.("https://mac.example/rubato/?pair=one-time"))
    expect(onResult).toHaveBeenCalledWith("https://mac.example/rubato/?pair=one-time")
    view.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  test("offers manual recovery when camera permission is denied", async () => {
    const createScanner: CameraScannerFactory = async () => {
      throw new DOMException("denied", "NotAllowedError")
    }
    render(<CameraQrScanner createScanner={createScanner} onResult={() => {}} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("iPhone 설정에서 카메라를 허용하거나 직접 입력하세요.")
  })
})
