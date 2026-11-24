// @vitest-environment jsdom

import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const configs = {
  providerInstances: { agy: { environment: [{name: "RUBATO_LOCAL_AGY_AGENT", value: "rubato-lead"}] } },
  get: () => ({
    providers: [
      { instanceId: "rubato", driver: "rubato-pi" },
      { instanceId: "agy", driver: "antigravity" },
      { instanceId: "plain", driver: "antigravity" },
      { instanceId: "codex", driver: "codex" },
    ],
  }),
};
const LIBRARY = [
  { id: "file:/Users/me/.rubato/prompts/memo.md", label: "비망록-v1.3", source: "/Users/me/.rubato/prompts/memo.md" },
];

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => configs }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => configs } }));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: { settingsValueAtom: () => ({}) } }));
const http = vi.hoisted(() => ({ calls: 0, fail: false, connected: true, hold: null as Promise<void> | null }));
vi.mock("~/state/rubatoHttp", () => ({
  postRubato: async (_environmentId: string, _route: string, action: string) => {
    http.calls += 1;
    if (http.hold) await http.hold;
    if (http.fail) throw new Error("This Mac is not connected.");
    return action === "list" ? { prompts: LIBRARY } : action === "prepare" ? { prompt: LIBRARY[0] } : {};
  },
}));
vi.mock("~/state/session", async () => {
  const Option = await import("effect/Option");
  return { usePreparedConnection: () => (http.connected ? Option.some({}) : Option.none()) };
});

import {
  openRubatoSessionPromptMenu,
  prepareRubatoSessionPrompt,
  RubatoSessionPromptBadge,
  rubatoSessionPromptAvailable,
  RubatoSessionPromptPicker,
  sessionPromptChoice,
} from "./RubatoSessionPrompt";

const ENV = "env-1" as EnvironmentId;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  Object.assign(http, { calls: 0, fail: false, connected: true, hold: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const chip = () => container.querySelector("[data-rubato-session-prompt]");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function renderPicker(draftKey: string, instanceId = "rubato") {
  await act(async () => {
    root.render(<RubatoSessionPromptPicker environmentId={ENV} draftKey={draftKey} instanceId={instanceId} />);
  });
  await settle();
}

describe("/prompt", () => {
  it("is offered only for a draft that runs on a Rubato model", () => {
    expect(rubatoSessionPromptAvailable(ENV, "draft", "rubato")).toBe(true);
    expect(rubatoSessionPromptAvailable(ENV, "draft", "agy")).toBe(true);
    expect(rubatoSessionPromptAvailable(ENV, "draft", "plain")).toBe(false);
    expect(rubatoSessionPromptAvailable(ENV, "draft", "codex")).toBe(false);
    expect(rubatoSessionPromptAvailable(ENV, null, "rubato")).toBe(false);
  });
});

describe("RubatoSessionPromptPicker", () => {
  it("ignores a list failure that arrives after its menu closed", async () => {
    await renderPicker("draft-late");
    let release!: () => void;
    http.hold = new Promise<void>((resolve) => { release = resolve; });
    http.fail = true;
    await act(async () => openRubatoSessionPromptMenu("draft-late"));
    await settle();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(chip()).toBeNull();
    await act(async () => release());
    await settle();
    expect(chip()).toBeNull();
  });

  it("drops a failed list's notice when the menu that asked for it closes", async () => {
    await renderPicker("draft-fail");
    http.fail = true;
    await act(async () => openRubatoSessionPromptMenu("draft-fail"));
    await settle();
    expect(chip()?.textContent).toContain("This Mac is not connected.");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(chip()).toBeNull();
  });

  it("waits for the Mac's connection and shows no error chip for a background load", async () => {
    http.connected = false;
    await renderPicker("draft-offline");
    expect(http.calls).toBe(0);
    expect(chip()).toBeNull();
    http.connected = true;
    http.fail = true;
    await renderPicker("draft-offline");
    expect(http.calls).toBe(1);
    // The load failed, but nothing the person asked for is missing: Rubato's own prompt shows nothing.
    expect(chip()).toBeNull();
  });

  it("shows nothing on Rubato's own prompt until /prompt opens its menu", async () => {
    await renderPicker("draft-a");
    expect(chip()).toBeNull();

    await act(async () => openRubatoSessionPromptMenu("draft-a"));
    await settle();
    expect(chip()?.textContent).toContain("Rubato 기본");
    const item = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes("비망록-v1.3"),
    ) as HTMLElement | undefined;
    expect(item).toBeDefined();

    await act(async () => item!.click());
    await settle();
    expect(sessionPromptChoice("draft-a")).toMatchObject({ kind: "file", label: "비망록-v1.3" });
    expect(chip()?.textContent).toContain("비망록-v1.3");
  });

  it("keeps a chosen prompt on screen and drops it with the clear button", async () => {
    localStorage.setItem("rubato.sessionPrompt.last", LIBRARY[0]!.id);
    await renderPicker("draft-b");
    expect(chip()?.textContent).toContain("비망록-v1.3");

    const clear = container.querySelector<HTMLButtonElement>('[aria-label="Rubato 기본 프롬프트로 되돌리기"]');
    await act(async () => clear!.click());
    await settle();
    expect(sessionPromptChoice("draft-b")).toEqual({ kind: "default" });
    expect(chip()).toBeNull();
    expect(localStorage.getItem("rubato.sessionPrompt.last")).toBe("default");
  });

  it("opens a local agy draft with the library choice and keeps its name on the thread", async () => {
    localStorage.setItem("rubato.sessionPrompt.last", LIBRARY[0]!.id);
    await renderPicker("draft-agy", "agy");
    expect(chip()?.textContent).toContain("비망록-v1.3");
    await prepareRubatoSessionPrompt({ environmentId: ENV, draftKey: "draft-agy", threadId: "thread-agy", instanceId: "agy" });
    expect(sessionPromptChoice("draft-agy")).toEqual({ kind: "default" });
    await act(async () => root.render(<RubatoSessionPromptBadge environmentId={ENV} threadId="thread-agy" />));
    expect(container.querySelector("[data-rubato-session-prompt-badge]")?.textContent).toContain("비망록-v1.3");
  });

  it("does not open for another draft or a model that is not Rubato", async () => {
    await renderPicker("draft-c", "codex");
    await act(async () => openRubatoSessionPromptMenu("draft-c"));
    await settle();
    expect(chip()).toBeNull();

    await renderPicker("draft-d");
    await act(async () => openRubatoSessionPromptMenu("draft-e"));
    await settle();
    expect(chip()).toBeNull();
  });
});
