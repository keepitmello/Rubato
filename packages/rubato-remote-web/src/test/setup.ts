import "@testing-library/jest-dom/vitest"

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock, configurable: true })
Object.defineProperty(navigator, "onLine", { value: true, configurable: true })
Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "" }, configurable: true })
Object.defineProperty(window, "matchMedia", { value: (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }), configurable: true })
Object.defineProperty(HTMLElement.prototype, "scrollTo", { value() {}, configurable: true })
