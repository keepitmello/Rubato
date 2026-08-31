import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { NewSessionScreen } from "./NewSessionScreen"

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("../lib/router", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/router")>(), navigate }))

function renderNewSession() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><KonstaApp theme="ios"><NewSessionScreen /></KonstaApp></QueryClientProvider>)
}

describe("new session shell", () => {
  beforeEach(() => history.replaceState(null, "", "/new?fixture=1"))

  test("keeps the host-project-options path with one primary action", async () => {
    renderNewSession()
    expect(screen.getByRole("heading", { name: "어느 Mac에서 시작할까요?" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "계속" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "계속" }))
    expect(await screen.findByRole("heading", { name: "무엇을 이어갈까요?" })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("radio", { name: "Hotel Tablet" }))
    fireEvent.click(screen.getByRole("button", { name: "계속" }))
    expect(screen.getByRole("heading", { name: "시작할 준비가 됐어요." })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "세션 시작" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "계속" })).not.toBeInTheDocument()
  })
})
