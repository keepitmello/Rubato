import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { fixtureSession } from "../lib/fixtures"
import { SessionScreen } from "./SessionScreen"

const { sendActionSpy } = vi.hoisted(() => ({ sendActionSpy: vi.fn(async () => undefined) }))
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), sendAction: sendActionSpy }))

function renderSession() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><KonstaApp theme="ios"><SessionScreen hostId={fixtureSession.hostId} liveSessionId={fixtureSession.liveSessionId} /></KonstaApp></QueryClientProvider>)
}

describe("session conversation", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/?fixture=1")
    sendActionSpy.mockClear()
  })

  test("does not submit Enter while Korean IME composition is active", async () => {
    renderSession()
    const input = await screen.findByLabelText("메시지")
    const initialMessages = screen.getAllByLabelText("내 메시지").length
    fireEvent.change(input, { target: { value: "접근성 확인" } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true })
    expect(screen.getAllByLabelText("내 메시지")).toHaveLength(initialMessages)
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13, isComposing: false })
    await waitFor(() => expect(screen.getAllByLabelText("내 메시지")).toHaveLength(initialMessages + 1))
    expect(screen.getByText("요청을 받아 작업을 시작했습니다…")).toBeInTheDocument()
  })

  test("opens structured controls and exposes recovery surfaces", async () => {
    renderSession()
    await screen.findByText("Hotel Tablet")
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    expect(screen.getByRole("dialog", { name: "세션 도구" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "대화 정리" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "비상 터미널" })).toBeInTheDocument()
  })

  test("offers only attached direct commands and submits the slash command unchanged", async () => {
    history.replaceState(null, "", "/?fixture=1&commands=skill%3Areview")
    renderSession()
    await screen.findByText("Hotel Tablet")
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    fireEvent.click(screen.getByRole("button", { name: "스킬과 명령" }))
    expect(screen.queryByRole("button", { name: /compact/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /login/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /skill:review/ }))
    expect(await screen.findByText("/skill:review", { exact: true })).toBeInTheDocument()
    expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "input.submit", { text: "/skill:review", imageIds: [], delivery: "auto" }, 123)
  })

  test("routes native commands to controls and terminal-only commands to the terminal", async () => {
    history.replaceState(null, "", "/?fixture=1&commands=compact%2Clogin")
    const view = renderSession()
    await screen.findByText("Hotel Tablet")
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    fireEvent.click(screen.getByRole("button", { name: "스킬과 명령" }))
    fireEvent.click(screen.getByRole("button", { name: /compact/ }))
    expect(screen.getByRole("dialog", { name: "대화 정리" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "정리 시작" }))
    expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "session.compact", {}, 123)
    sendActionSpy.mockClear()
    view.unmount()

    renderSession()
    await screen.findByText("Hotel Tablet")
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    fireEvent.click(screen.getByRole("button", { name: "스킬과 명령" }))
    fireEvent.click(screen.getByRole("button", { name: /login/ }))
    expect(await screen.findByRole("dialog", { name: "비상 터미널" })).toBeInTheDocument()
    expect(screen.getByText("/login 명령은 비상 터미널에서 실행해야 합니다.")).toBeInTheDocument()
    expect(sendActionSpy).not.toHaveBeenCalled()
  })
})
