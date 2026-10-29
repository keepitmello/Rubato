// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; body: Record<string, unknown> }>,
}));
vi.mock("./environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("./session", async () => {
  const Option = await import("effect/Option");
  const ready = Option.some({});
  return { usePreparedConnection: () => ready };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
  SettingsRow: ({ title, control, children }: { title: string; control?: ReactNode; children?: ReactNode }) =>
    <div><span>{title}</span>{control}{children}</div>,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./rubatoHttp", () => ({
  postRubato: async (_env: unknown, _route: string, action: string, body: Record<string, unknown>) => {
    fake.calls.push({ action, body });
    const settings = { enabled: false, heartbeat: { enabled: true, everyMinutes: 30 },
      greetings: { enabled: true }, schedule: { sources: [] } };
    if (action === "companions") return { companions: [
      { id: "segno", title: "Segno", home: "/segno", sessionId: "s1", settings, heartbeatMinutes: [15, 30, 45] },
      { id: "other", title: "Other", home: "/original-repo", sessionId: "s2", settings, heartbeatMinutes: [15, 30, 45] },
    ] };
    if (action === "thread") return { threadId: body.sessionId === "s1" ? "thread-1" : "thread-2" };
    if (action === "pieces") return { pieces: [] };
    if (action === "telegram") return { telegram: null };
    if (action === "save-settings") return { id: body.companionId, title: "Other", home: "/original-repo",
      sessionId: "s2", settings: { ...settings, enabled: true }, heartbeatMinutes: [15, 30, 45] };
    return {};
  },
}));

import { RubatoCompanionSettingsPanel } from "../components/settings/RubatoCompanionSettings";
import { companionForThread, isCompanionThread, rubatoCompanion, useRubatoCompanion } from "./rubatoCompanion";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); });

it("the rendered picker switches homes and subsequent settings requests without changing the sibling", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current!: ReturnType<typeof useRubatoCompanion>;
  function Read() { current = useRubatoCompanion(); return <RubatoCompanionSettingsPanel />; }
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<Read />));
  await vi.waitFor(() => expect(host.querySelectorAll("select[aria-label=Companion] option")).toHaveLength(2));
  expect(isCompanionThread("thread-1")).toBe(true);
  expect(isCompanionThread("thread-2")).toBe(true);
  expect(companionForThread("thread-2")?.home).toBe("/original-repo");
  const picker = host.querySelector<HTMLSelectElement>("select[aria-label=Companion]")!;
  await act(async () => { picker.value = "other"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await vi.waitFor(() => expect(current.selectedId).toBe("other"));
  expect(current.status?.home).toBe("/original-repo");
  expect(current.threadId).toBe("thread-2");
  expect(host.querySelector("#rubato-companion")?.textContent ?? host.textContent).toContain("Other");
  await rubatoCompanion.saveSettings("local" as never, { enabled: true });
  expect(fake.calls.findLast(item => item.action === "save-settings")?.body.companionId).toBe("other");
  expect(fake.calls.filter(item => item.action === "save-settings" && item.body.companionId === "segno")).toHaveLength(0);
});
