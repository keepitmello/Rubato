import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { App } from "./App"
import { useAppStore } from "./lib/store"

vi.mock("./lib/registry", () => ({ listRegisteredHosts: async () => [] }))

const defaultPreferences = { darkMode: "system" as const, reducedTransparency: false, terminalFontSize: 14, pushEnabled: false, favorites: [] as readonly string[] }

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
}

function stubColorScheme(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null as MediaQueryList["onchange"],
    addListener() {},
    removeListener() {},
    addEventListener(_type: string, listener: EventListener) { listeners.add(listener as (event: MediaQueryListEvent) => void) },
    removeEventListener(_type: string, listener: EventListener) { listeners.delete(listener as (event: MediaQueryListEvent) => void) },
    dispatchEvent() { return false },
    setMatches(next: boolean) {
      media.matches = next
      for (const listener of listeners) listener({ matches: next, media: media.media } as MediaQueryListEvent)
    },
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => query.includes("prefers-color-scheme: dark") ? media : {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    },
  })
  return media
}

function konstaDark(container: HTMLElement) {
  return Boolean(container.querySelector(".k-navbar")?.className.includes("dark:"))
}

describe("app theme", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/?fixture=1")
    useAppStore.setState({ preferences: { ...defaultPreferences } })
    document.documentElement.classList.remove("dark")
    document.documentElement.removeAttribute("data-theme")
    stubColorScheme(false)
  })

  test("boots Konsta iOS theme and the inventory shell", async () => {
    const { container } = renderApp()
    expect(container.querySelector(".k-ios")).not.toBeNull()
    expect(await screen.findByText("Rubato")).toBeInTheDocument()
  })

  test("light preference does not render Konsta dark and matches the root class", () => {
    useAppStore.setState({ preferences: { ...defaultPreferences, darkMode: "light" } })
    const { container } = renderApp()
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(konstaDark(container)).toBe(false)
  })

  test("dark preference renders Konsta dark and matches the root class", () => {
    useAppStore.setState({ preferences: { ...defaultPreferences, darkMode: "dark" } })
    const { container } = renderApp()
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(konstaDark(container)).toBe(true)
  })

  test("system preference follows the color-scheme media query", () => {
    const media = stubColorScheme(true)
    const { container } = renderApp()
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(konstaDark(container)).toBe(true)
    act(() => media.setMatches(false))
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(konstaDark(container)).toBe(false)
  })
})

describe("app updates", () => {
  afterEach(() => vi.unstubAllEnvs())

  test("activates the waiting worker before reloading", async () => {
    vi.stubEnv("DEV", false)
    history.replaceState(null, "", "/")
    useAppStore.setState({ preferences: { ...defaultPreferences } })
    stubColorScheme(false)
    const waiting = { postMessage: vi.fn() }
    const controller = { postMessage: vi.fn() }
    const registration = { waiting, addEventListener: vi.fn() }
    const serviceWorker = { controller, register: vi.fn().mockResolvedValue(registration), addEventListener: vi.fn() }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker })

    renderApp()
    await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled())
    const updateButton = await screen.findByRole("button", { name: "지금 업데이트" })
    expect(updateButton).not.toBeDisabled()
    fireEvent.click(updateButton)

    expect(serviceWorker.addEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function), { once: true })
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })
    expect(controller.postMessage).not.toHaveBeenCalled()
    expect(await screen.findByRole("button", { name: "업데이트 중…" })).toBeDisabled()
  })
})
