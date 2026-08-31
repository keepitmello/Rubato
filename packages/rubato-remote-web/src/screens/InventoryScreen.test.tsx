import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { fixtureSession } from "../lib/fixtures"
import { InventoryScreen } from "./InventoryScreen"

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("../lib/router", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/router")>(), navigate }))

function renderInventory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><KonstaApp theme="ios"><InventoryScreen /></KonstaApp></QueryClientProvider>)
}

describe("inventory home screen", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/?fixture=1")
    navigate.mockClear()
  })

  test("leads with session title and status, demotes cwd, and drops decorative hero copy", async () => {
    renderInventory()
    const session = await screen.findByRole("button", { name: /Hotel Tablet/ }, { timeout: 5000 })
    expect(session).toBeInTheDocument()
    const text = session.textContent ?? ""
    expect(text.indexOf("Hotel Tablet")).toBeLessThan(text.indexOf("대기"))
    expect(text.indexOf("대기")).toBeLessThan(text.indexOf("~/Projects/hotel-tablet"))
    expect(screen.queryByText("Live work")).not.toBeInTheDocument()
    expect(screen.queryByText(/어디서든 같은 작업/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "새 세션" })).toBeInTheDocument()
  })

  test("opens the live session from the list", async () => {
    renderInventory()
    fireEvent.click(await screen.findByRole("button", { name: /Hotel Tablet/ }, { timeout: 5000 }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/session/${fixtureSession.hostId}/${fixtureSession.liveSessionId}`))
  })
})
