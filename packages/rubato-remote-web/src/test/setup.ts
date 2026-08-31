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
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value(this: HTMLElement, x?: ScrollToOptions | number, y?: number) {
    if (typeof x === "object" && x) {
      if (typeof x.left === "number") this.scrollLeft = x.left
      if (typeof x.top === "number") this.scrollTop = x.top
      return
    }
    if (typeof x === "number") this.scrollLeft = x
    if (typeof y === "number") this.scrollTop = y
  },
})
