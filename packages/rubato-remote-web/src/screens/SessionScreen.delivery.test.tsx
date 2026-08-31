import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { fixtureSession } from "../lib/fixtures"
import { SessionScreen } from "./SessionScreen"

const { sendActionSpy } = vi.hoisted(() => ({ sendActionSpy: vi.fn(async () => undefined) }))

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>()
  return { ...actual, sendAction: sendActionSpy }
})

function renderWorkingSession() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <KonstaApp theme="ios">
        <SessionScreen hostId={fixtureSession.hostId} liveSessionId={fixtureSession.liveSessionId} />
      </KonstaApp>
    </QueryClientProvider>,
  )
}

describe("working session delivery choice", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/?fixture=1&state=working")
    sendActionSpy.mockReset()
    sendActionSpy.mockImplementation(async () => undefined)
  })

  test("queues the ordinary send for the next turn by default", async () => {
    renderWorkingSession()
    const input = await screen.findByLabelText("메시지")
    const nextTurn = screen.getByRole("button", { name: /다음 차례/ })
    expect(nextTurn).toHaveAttribute("aria-pressed", "true")

    fireEvent.change(input, { target: { value: "테스트가 끝나면 결과도 정리해 줘" } })
    fireEvent.click(screen.getByLabelText("다음 차례에 보내기"))

    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(
      expect.anything(),
      fixtureSession.liveSessionId,
      "input.followUp",
      { text: "테스트가 끝나면 결과도 정리해 줘", imageIds: [] },
    ))
  })

  test("uses steer only after explicit selection and returns to next-turn mode", async () => {
    renderWorkingSession()
    const input = await screen.findByLabelText("메시지")
    const steer = screen.getByRole("button", { name: /현재 작업에 반영/ })
    fireEvent.click(steer)
    expect(steer).toHaveAttribute("aria-pressed", "true")

    fireEvent.change(input, { target: { value: "방금 파일은 수정하지 마" } })
    fireEvent.click(screen.getByLabelText("즉시 반영할 지시 보내기"))

    await waitFor(() => expect(sendActionSpy).toHaveBeenCalledWith(
      expect.anything(),
      fixtureSession.liveSessionId,
      "input.steer",
      { text: "방금 파일은 수정하지 마", imageIds: [] },
    ))
    await waitFor(() => expect(screen.getByRole("button", { name: /다음 차례/ })).toHaveAttribute("aria-pressed", "true"))
  })
})
