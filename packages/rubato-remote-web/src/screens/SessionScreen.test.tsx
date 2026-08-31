import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { fixtureSession, fixtureSnapshot } from "../lib/fixtures"
import { SessionScreen } from "./SessionScreen"

const { sendActionSpy, fetchSnapshotSpy, fetchOlderMessagesSpy, originals } = vi.hoisted(() => ({
  sendActionSpy: vi.fn(async () => undefined),
  fetchSnapshotSpy: vi.fn(),
  fetchOlderMessagesSpy: vi.fn(),
  originals: {} as { fetchSnapshot?: typeof import("../lib/api").fetchSnapshot; fetchOlderMessages?: typeof import("../lib/api").fetchOlderMessages },
}))

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>()
  originals.fetchSnapshot = actual.fetchSnapshot
  originals.fetchOlderMessages = actual.fetchOlderMessages
  fetchSnapshotSpy.mockImplementation(actual.fetchSnapshot)
  fetchOlderMessagesSpy.mockImplementation(actual.fetchOlderMessages)
  return {
    ...actual,
    sendAction: sendActionSpy,
    fetchSnapshot: fetchSnapshotSpy,
    fetchOlderMessages: fetchOlderMessagesSpy,
  }
})

function renderSession() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><KonstaApp theme="ios"><SessionScreen hostId={fixtureSession.hostId} liveSessionId={fixtureSession.liveSessionId} /></KonstaApp></QueryClientProvider>)
}

function pageOwner(): HTMLElement {
  return document.querySelector(".k-page") as HTMLElement
}

function mockPageMetrics() {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!(this instanceof HTMLElement) || !this.classList.contains("k-page")) return 0
      return 800 + this.querySelectorAll(".k-message").length * 180
    },
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this instanceof HTMLElement && this.classList.contains("k-page") ? 600 : 0
    },
  })
}

describe("session conversation", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/?fixture=1")
    sendActionSpy.mockReset()
    sendActionSpy.mockImplementation(async () => undefined)
    fetchSnapshotSpy.mockReset()
    fetchSnapshotSpy.mockImplementation(originals.fetchSnapshot!)
    fetchOlderMessagesSpy.mockReset()
    fetchOlderMessagesSpy.mockImplementation(originals.fetchOlderMessages!)
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
    expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "input.submit", { text: "/skill:review", imageIds: [], delivery: "auto" })
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

  test("renames through session.rename, refreshes summary immediately, and shows success", async () => {
    renderSession()
    await screen.findByText("Hotel Tablet")
    const snapshotCalls = fetchSnapshotSpy.mock.calls.length
    fetchSnapshotSpy.mockImplementation(async () => ({
      ...fixtureSnapshot,
      summary: { ...fixtureSnapshot.summary, title: "Protocol work" },
    }))
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    fireEvent.click(screen.getByRole("button", { name: "이름 바꾸기" }))
    fireEvent.change(screen.getByLabelText("세션 이름"), { target: { value: "Protocol work" } })
    fireEvent.click(screen.getByRole("button", { name: "저장" }))
    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "session.rename", { name: "Protocol work" }, 123))
    await waitFor(() => expect(fetchSnapshotSpy.mock.calls.length).toBeGreaterThan(snapshotCalls))
    expect(await screen.findByText("이름을 바꿨습니다.")).toBeInTheDocument()
    expect(await screen.findByText("Protocol work")).toBeInTheDocument()
  })

  test("shows a visible failure when session.rename is rejected", async () => {
    sendActionSpy.mockRejectedValueOnce(new Error("세션 이름을 바꾸지 못했어요."))
    renderSession()
    await screen.findByText("Hotel Tablet")
    const snapshotCalls = fetchSnapshotSpy.mock.calls.length
    fireEvent.click(screen.getByLabelText("세션 제어 열기"))
    fireEvent.click(screen.getByRole("button", { name: "이름 바꾸기" }))
    fireEvent.change(screen.getByLabelText("세션 이름"), { target: { value: "Protocol work" } })
    fireEvent.click(screen.getByRole("button", { name: "저장" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("세션 이름을 바꾸지 못했어요.")
    expect(screen.getByRole("dialog", { name: "이름 바꾸기" })).toBeInTheDocument()
    expect(screen.getByLabelText("세션 이름")).toHaveValue("Protocol work")
    expect(fetchSnapshotSpy.mock.calls.length).toBe(snapshotCalls)
  })

  test("lands first entry at the latest message on the page scroll owner", async () => {
    mockPageMetrics()
    renderSession()
    await screen.findByLabelText("내 메시지")
    await waitFor(() => {
      const page = pageOwner()
      expect(page.scrollTop).toBe(page.scrollHeight)
    })
  })

  test("preserves reading position when older messages are prepended", async () => {
    mockPageMetrics()
    fetchOlderMessagesSpy.mockResolvedValueOnce([
      { id: "older-1", kind: "message", role: "user", text: "예전 요청입니다." },
    ])
    renderSession()
    await screen.findByLabelText("내 메시지")
    const page = pageOwner()
    await waitFor(() => expect(page.scrollTop).toBe(page.scrollHeight))
    const heightBefore = page.scrollHeight
    page.scrollTop = 220
    fireEvent.scroll(page)
    fireEvent.click(screen.getByRole("button", { name: "이전 대화 보기" }))
    expect(await screen.findByText("예전 요청입니다.")).toBeInTheDocument()
    await waitFor(() => expect(page.scrollHeight).toBeGreaterThan(heightBefore))
    expect(page.scrollTop).toBe(220 + (page.scrollHeight - heightBefore))
    expect(page.scrollTop).not.toBe(page.scrollHeight)
  })

  test("opens model settings from badges, marks current choices, dispatches valid ids, and refetches", async () => {
    renderSession()
    await screen.findByText("Hotel Tablet")
    const snapshotCalls = fetchSnapshotSpy.mock.calls.length
    fireEvent.click(screen.getByLabelText("GPT-5.6 모델 설정"))
    expect(screen.getByRole("dialog", { name: "모델과 추론" })).toBeInTheDocument()
    expect(screen.getByRole("button", { current: true, name: /GPT-5.6/ })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /높음/ })).toHaveAttribute("aria-current", "true")
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }))
    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "model.set", { provider: "kiro", modelId: "claude-opus-5" }, 123))
    await waitFor(() => expect(fetchSnapshotSpy.mock.calls.length).toBeGreaterThan(snapshotCalls))
    expect(await screen.findByText("Claude로 바꿨습니다.")).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("GPT-5.6 모델 설정"))
    fireEvent.click(screen.getByRole("button", { name: /GPT-5.6 Sol/ }))
    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "model.set", { provider: "openai-codex", modelId: "gpt-5.6-sol" }, 123))
    expect(await screen.findByText("GPT-5.6 Sol로 바꿨습니다.")).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("GPT-5.6 모델 설정"))
    fireEvent.click(screen.getByRole("button", { name: /Grok 4.6/ }))
    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "model.set", { provider: "cursor", modelId: "cursor-grok-4.6" }, 123))
    expect(await screen.findByText("Grok 4.6으로 바꿨습니다.")).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("높은 추론 설정"))
    fireEvent.click(screen.getByRole("button", { name: /보통/ }))
    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "thinking.set", { level: "medium" }, 123))
    expect(await screen.findByText("보통으로 바꿨습니다.")).toBeInTheDocument()
  })

  test("keeps only user and assistant messages in the session transcript", async () => {
    renderSession()
    await screen.findByLabelText("내 메시지")
    expect(screen.getAllByLabelText("내 메시지")).toHaveLength(1)
    expect(screen.getAllByLabelText("Rubato 응답")).toHaveLength(1)
    expect(document.querySelectorAll(".k-message")).toHaveLength(2)
    expect(document.querySelector(".entry")).toBeNull()
    expect(screen.queryByText("생각 과정")).not.toBeInTheDocument()
    expect(screen.queryByText("화면 구조와 현재 테스트를 함께 확인하고 있습니다.")).not.toBeInTheDocument()
    expect(screen.queryByText("파일 읽기")).not.toBeInTheDocument()
    expect(screen.queryByText("접근성 테스트 4개 통과")).not.toBeInTheDocument()
  })

  test("uses a Konsta messagebar with one primary send action", async () => {
    renderSession()
    const input = await screen.findByLabelText("메시지")
    expect(document.querySelector(".k-messagebar")).not.toBeNull()
    expect(input.tagName).toBe("TEXTAREA")
    expect(screen.getByLabelText("메시지 보내기")).toBeInTheDocument()
    expect(screen.queryByLabelText("즉시 반영할 지시 보내기")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "중단" })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText("메시지 보내기")).toHaveLength(1)
    fireEvent.change(input, { target: { value: "이어서 확인" } })
    fireEvent.click(screen.getByLabelText("메시지 보내기"))
    expect(await screen.findByText("이어서 확인")).toBeInTheDocument()
    expect(sendActionSpy).toHaveBeenCalledWith(expect.anything(), fixtureSession.liveSessionId, "input.submit", { text: "이어서 확인", imageIds: [], delivery: "auto" })
  })

  test("shows a visible failure when model or effort actions are rejected", async () => {
    sendActionSpy.mockRejectedValueOnce(new Error("모델을 바꾸지 못했어요."))
    renderSession()
    await screen.findByText("Hotel Tablet")
    const snapshotCalls = fetchSnapshotSpy.mock.calls.length
    fireEvent.click(screen.getByLabelText("GPT-5.6 모델 설정"))
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("모델을 바꾸지 못했어요.")
    expect(screen.getByRole("dialog", { name: "모델과 추론" })).toBeInTheDocument()
    expect(fetchSnapshotSpy.mock.calls.length).toBe(snapshotCalls)

    sendActionSpy.mockRejectedValueOnce(new Error("추론 강도를 바꾸지 못했어요."))
    fireEvent.click(screen.getByRole("button", { name: /보통/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("추론 강도를 바꾸지 못했어요.")
    expect(screen.getByRole("dialog", { name: "모델과 추론" })).toBeInTheDocument()
    expect(fetchSnapshotSpy.mock.calls.length).toBe(snapshotCalls)
  })
})
