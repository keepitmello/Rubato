// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useCompanions } from "./companionsStore";

const { catalog } = vi.hoisted(() => ({ catalog: vi.fn(async () => ({ companions: [] })) }));
vi.mock("react-native", () => ({ AppState: {
  currentState: "active", addEventListener: () => ({ remove() {} }),
} }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("./copy", () => ({ copy: {} }));
vi.mock("../../../modules/rubato-call", () => ({ RubatoCall: null }));
vi.mock("./callStore", () => ({ callApi: { companions: async () => [] } }));
vi.mock("./rubatoHttp", () => ({ postRubato: catalog }));
vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null, setItemAsync: async () => {} } }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [{ environmentId: "mac" }] }) }));

function List({ visible }: { visible: boolean }) {
  useCompanions(visible);
  return null;
}

it("a covered list stops polling; fast pops reuse fresh data and a later pop refreshes once", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const show = (visible: boolean) => act(async () => root.render(createElement(List, { visible })));
  try {
    await show(true);
    for (let i = 0; i < 10; i++) { await show(false); await show(true); }
    expect(catalog).toHaveBeenCalledTimes(1);
    await show(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(catalog).toHaveBeenCalledTimes(1);
    await show(true);
    expect(catalog).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
