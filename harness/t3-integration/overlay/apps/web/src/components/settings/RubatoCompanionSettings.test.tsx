// @vitest-environment jsdom
// Settings › Companion as the person uses it (intent companion-manage): the list always shows and
// makes a new companion, the cards read the companion's own words and open its room with a draft,
// the Telegram row shows only for a profile with Telegram, and Advanced still edits every piece.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; body: Record<string, unknown> }>,
  navigate: vi.fn(async () => undefined),
  setPrompt: vi.fn(),
  companions: [] as Array<Record<string, unknown>>,
  created: false,
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  const ready = Option.some({});
  return { usePreparedConnection: () => ready };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fake.navigate }));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (text: string, values: Record<string, unknown> = {}) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
  useMessages: () => (text: string) => text,
  T: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
  SettingsRow: ({ id, title, control, children }: { id?: string; title: string; control?: ReactNode; children?: ReactNode }) =>
    <div id={id}><span>{title}</span>{control}{children}</div>,
}));
vi.mock("./RubatoCompanionPicture", () => ({ RubatoCompanionPicture: () => <div data-testid="picture" /> }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: { getState: () => ({ setPrompt: fake.setPrompt }) } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../state/rubatoHttp", () => ({
  postRubato: async (_env: unknown, _route: string, action: string, body: Record<string, unknown>) => {
    fake.calls.push({ action, body });
    if (action === "companions") return { companions: fake.companions };
    if (action === "create") {
      fake.created = true;
      fake.companions = [...fake.companions, row("c-new", null, { sessionId: "s-new", onboarding: { items: [] }, madeInApp: true })];
      return { companion: { id: "c-new", sessionId: null } };
    }
    if (action === "thread") return { threadId: `thread-${String(body.sessionId)}` };
    if (action === "summaries")
      return body.companionId === "segno"
        ? { who: { rows: [{ key: "line", text: "겉은 늑대, 속은 강아지" }] }, me: null, updatedAt: null }
        : { who: null, me: null, updatedAt: null };
    if (action === "pieces")
      return { pieces: ["soul", "user", "tools"].map((id) => ({ id, title: `Piece ${id}`, description: "", editable: id !== "tools", defaultText: `${id} text` })) };
    if (action === "telegram")
      return { telegram: { settings: { enabled: false, approvalRequired: true }, bot: { token: null }, pairing: { status: "unpaired" },
        handoff: {}, home: "/h", waiting: [], recent: [] } };
    if (action === "avatar") return { avatar: null };
    return {};
  },
}));

const settings = { enabled: true, heartbeat: { enabled: true, everyMinutes: 30 }, greetings: { enabled: true },
  schedule: { sources: [] }, call: { effort: "conversation" } };
function row(id: string, title: string | null, extra: Record<string, unknown> = {}) {
  return { id, title, home: `/${id}`, sessionId: `s-${id}`, settings, heartbeatMinutes: [15, 30],
    profile: { callsUser: "오빠", since: "2026-10-20" }, avatarVersion: null, onboarding: null, telegram: false, ...extra };
}

import { RubatoCompanionSettingsPanel } from "./RubatoCompanionSettings";

let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fake.calls.length = 0;
  fake.navigate.mockClear();
  fake.setPrompt.mockClear();
});
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () => root.render(<RubatoCompanionSettingsPanel />));
  return host;
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

it("lists a single companion too, with its card in its own words and a way to change it by talking", async () => {
  fake.companions = [row("segno", "Segno")];
  const host = await mount();
  await vi.waitFor(() => expect(host.querySelectorAll("[data-rubato-companion-item]")).toHaveLength(1));
  expect(host.querySelector("[data-rubato-companion-new]")?.textContent).toContain("New companion");
  await vi.waitFor(() => expect(host.textContent).toContain("겉은 늑대, 속은 강아지"));
  expect(host.querySelector("#rubato-companion-who h3")?.textContent).toBe("Who Segno is");
  expect(host.textContent).toContain("Calls you 오빠");
  // Segno has no Telegram in its profile: no Telegram row, even while the product answers a status.
  await vi.waitFor(() => expect(host.querySelector("#rubato-companion-voice")).not.toBeNull());
  expect(host.querySelector("#rubato-companion-telegram")).toBeNull();
  await act(async () => button(host.querySelector<HTMLElement>("#rubato-companion-who")!, "Change by talking")!.click());
  expect(fake.setPrompt).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-s-segno" }), "About the card on who you are: ");
  expect(fake.navigate).toHaveBeenCalledWith({ to: "/$environmentId/$threadId", params: { environmentId: "local", threadId: "thread-s-segno" } });
  // The card it has not written yet offers to ask for it instead.
  await act(async () => button(host.querySelector<HTMLElement>("#rubato-companion-me")!, "Ask it to sum up")!.click());
  expect(fake.setPrompt).toHaveBeenLastCalledWith(expect.anything(), "Could you sum up what you know about me for your card?");
  expect(fake.calls.some((call) => call.action === "save-piece")).toBe(false);
});

it("keeps every piece editable under Advanced, and Full text opens the card's piece there", async () => {
  fake.companions = [row("segno", "Segno")];
  const host = await mount();
  await vi.waitFor(() => expect(host.querySelector("#rubato-companion-me")).not.toBeNull());
  expect(host.querySelector("#rubato-companion-piece-soul")).toBeNull();
  await act(async () => button(host.querySelector<HTMLElement>("#rubato-companion-me")!, "Full text")!.click());
  await vi.waitFor(() => expect(host.querySelector("#rubato-companion-piece-user textarea")).not.toBeNull());
  expect(host.querySelector("#rubato-companion-piece-soul")).not.toBeNull();
  expect(host.querySelector("#rubato-companion-piece-tools")).not.toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>("#rubato-companion-piece-user textarea")?.value).toBe("user text");
});

it("shows Telegram only for a profile that has it, and switching never touches the other companion", async () => {
  fake.companions = [row("segno", "Segno"), row("roo", "Roo", { telegram: true })];
  const host = await mount();
  await vi.waitFor(() => expect(host.querySelectorAll("[data-rubato-companion-item]")).toHaveLength(2));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-rubato-companion-item="roo"]')!.click());
  await vi.waitFor(() => expect(host.querySelector('[data-rubato-companion-detail="roo"]')).not.toBeNull());
  await vi.waitFor(() => expect(host.querySelector("#rubato-companion-telegram")).not.toBeNull());
  expect(fake.calls.filter((call) => call.action === "save-settings")).toHaveLength(0);
});

it("makes a new companion from the list and opens its room once it is awake", async () => {
  fake.companions = [row("segno", "Segno")];
  const host = await mount();
  await vi.waitFor(() => expect(host.querySelector("[data-rubato-companion-new]")).not.toBeNull());
  await act(async () => host.querySelector<HTMLButtonElement>("[data-rubato-companion-new]")!.click());
  await vi.waitFor(() => expect(fake.navigate).toHaveBeenCalledWith({ to: "/$environmentId/$threadId", params: { environmentId: "local", threadId: "thread-s-new" } }));
  expect(fake.calls.find((call) => call.action === "create")?.body).toEqual({});
  // Nameless until its onboarding names it: "New companion" with a "?" face, selected.
  const item = host.querySelector('[data-rubato-companion-item="c-new"]')!;
  expect(item.textContent).toContain("New companion");
  expect(item.querySelector("[data-rubato-companion-face]")?.textContent).toBe("?");
  expect(item.getAttribute("aria-current")).toBe("true");
});
