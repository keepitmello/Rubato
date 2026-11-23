// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { RoomLeadsSheet } from "./RoomLeadsSheet";

const state = vi.hoisted(() => ({
  shells: [] as EnvironmentThreadShell[], open: vi.fn(), close: vi.fn(), settle: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.shells }));
vi.mock("../../state/threads", () => ({ steadyNavigationThreadShellsAtom: {} }));
vi.mock("gt-react-native", () => ({ useGT: () => (text: string) => text }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({ useSelectWorkspaceDetail: () => state.open }));
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => ({ settleThread: state.settle }) }));
vi.mock("../home/ThreadUndoNotice", () => ({ ThreadUndoNotice: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("../../components/ui/AppText", () => ({ AppText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: ({ children, renderLeftActions }: {
    children: ReactNode; renderLeftActions: (progress: null, drag: null, methods: { close: () => void }) => ReactNode;
  }) => <div>{children}{renderLeftActions(null, null, { close() {} })}</div>,
}));
vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, accessibilityLabel }: {
    children: ReactNode; onPress: () => void; accessibilityLabel?: string;
  }) => <button type="button" onClick={onPress} aria-label={accessibilityLabel}>{children}</button>,
  FlatList: ({ data, renderItem, ListEmptyComponent }: {
    data: EnvironmentThreadShell[]; renderItem: (row: { item: EnvironmentThreadShell; index: number }) => ReactNode;
    ListEmptyComponent: ReactNode;
  }) => data.length ? data.map((item, index) => <div key={item.id}>{renderItem({ item, index })}</div>) : ListEmptyComponent,
}));

it("opens, settles and removes real work instead of showing historical launches as Starting", async () => {
  const environmentId = "mac" as EnvironmentId;
  const row = {
    id: "import:pi:mac:current", environmentId, title: "Current task", runtime: { status: "idle" }, latestRun: null,
    archivedAt: null, deletedAt: null, settledOverride: null, updatedAt: "2026-11-23T10:00:00Z",
  } as EnvironmentThreadShell;
  const launches = ["current", "historic"].map((sessionId) => ({
    id: sessionId, title: sessionId, sessionId, at: 0, done: 1, error: null,
  }));
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () => root.render(<RoomLeadsSheet environmentId={environmentId} launches={launches} close={state.close} />);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    state.shells = [row];
    await act(async () => render());
    expect(host.querySelector("h1")?.textContent).toBe("Work");
    expect(host.textContent).not.toMatch(/historic|Starting/);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Current task, Idle work"]')!.click());
    expect(state.open).toHaveBeenCalledWith({ name: "Thread", params: { environmentId, threadId: row.id } });
    expect(state.close).toHaveBeenCalled();
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Settle")!.click());
    expect(state.settle).toHaveBeenCalledWith(row);
    state.shells = [{ ...row, settledOverride: "settled" }];
    await act(async () => render());
    expect(host.textContent).toContain("No work to pick up");
    expect(host.textContent).not.toContain("Current task");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
