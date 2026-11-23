// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { useSidebarCompanionWork } from "./rubatoSidebarCompanionWork";

const fake = vi.hoisted(() => ({
  show: false,
  post: vi.fn(),
  rooms: [{ id: "companion", sessionId: "session", threadId: "room", conversationThreadIds: ["old-room"] }],
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { rubatoShowCompanionLeads: boolean }) => boolean) =>
    select({ rubatoShowCompanionLeads: fake.show }),
}));
vi.mock("./rubatoCompanion", () => ({
  useReadyEnvironmentId: () => "mac",
  useRubatoCompanion: () => ({ companions: fake.rooms }),
}));
vi.mock("./rubatoHttp", () => ({ postRubato: fake.post }));

it("hides work by default and shows it on request without adding rooms back to the sidebar", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const all = ["room", "old-room", "import:pi:mac:lead", "import:pi:mac:fork", "personal"]
    .map((id) => ({ id, environmentId: "mac" as EnvironmentId }));
  fake.post.mockImplementation(async (_id, _route, action) =>
    action === "lead-sessions" ? { sessionIds: ["lead"] } : { workSessionIds: ["fork"] });
  let visible: readonly string[] = [];
  function SidebarList() {
    visible = useSidebarCompanionWork(all).map(({ id }) => id);
    return null;
  }
  try {
    await act(async () => root.render(<SidebarList />));
    expect(visible).toEqual(["personal"]);
    fake.show = true;
    await act(async () => root.render(<SidebarList />));
    expect(visible).toEqual(["import:pi:mac:lead", "import:pi:mac:fork", "personal"]);
    fake.show = false;
    await act(async () => root.render(<SidebarList />));
    expect(visible).toEqual(["personal"]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
