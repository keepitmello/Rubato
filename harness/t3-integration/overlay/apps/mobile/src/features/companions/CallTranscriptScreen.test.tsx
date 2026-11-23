// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CallTranscriptScreen } from "./CallTranscriptScreen";
import type { CallLine } from "./callTypes";

const state = vi.hoisted(() => ({ call: vi.fn(), index: 0, size: 0 }));
const params = { environmentId: "mac", companionId: "roo", callId: "picked" };
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true, useRoute: () => ({ params }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../lib/appState", () => ({ useAppActive: () => true }));
vi.mock("./callStore", () => ({ callApi: { call: state.call } }));
vi.mock("./companionsStore", () => ({ useCompanion: () => ({ companion: null }) }));
vi.mock("./copy", () => ({ copy: { nothingSaid: "empty" } }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("./CallCard", () => ({ CallSummary: () => <header>summary</header>, MeDot: () => <i>me</i> }));
vi.mock("./CompanionAvatar", () => ({ CompanionAvatar: () => <i>companion</i> }));
// Request one row as the native list would. All rows must be addressable without prebuilding bubbles.
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FlatList: (p: { data: CallLine[]; renderItem: (row: { item: CallLine }) => ReactNode; ListEmptyComponent: ReactNode }) => {
    state.size = p.data.length;
    return p.data.length ? p.renderItem({ item: p.data[state.index]! }) : p.ListEmptyComponent;
  },
}));

it("keeps both ends of a long call readable, skips directions, and stops refreshing once ended", async () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => ({
    who: i % 2 ? "companion" : "me", text: `[soft] line ${i}`, at: 0,
  }));
  state.call.mockResolvedValueOnce({ status: "active", transcript: [{ ...lines[0], text: "[soft]" }, ...lines] })
    .mockResolvedValueOnce({ status: "ended", transcript: lines });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<CallTranscriptScreen route={{ params }} />));
    expect(state.call).toHaveBeenCalledWith("mac", "roo", "picked", expect.any(AbortSignal));
    expect(state.size).toBe(2_000);
    expect(host.querySelector("span")?.textContent).toBe("line 0");
    expect(host.querySelector("i")?.textContent).toBe("me");
    state.index = 1_999;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(host.querySelector("span")?.textContent).toBe("line 1999");
    expect(host.querySelector("i")?.textContent).toBe("companion");
    expect(host.querySelector("header")?.textContent).toBe("summary");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(state.call).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
