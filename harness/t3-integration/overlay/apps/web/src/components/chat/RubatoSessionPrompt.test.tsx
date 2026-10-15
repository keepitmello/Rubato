// @vitest-environment jsdom

import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const configs = {
  get: () => ({
    providers: [
      { instanceId: "rubato", driver: "rubato-pi" },
      { instanceId: "codex", driver: "codex" },
    ],
  }),
};
const LIBRARY = [
  { id: "file:/Users/me/.rubato/prompts/memo.md", label: "비망록-v1.3", source: "/Users/me/.rubato/prompts/memo.md" },
];

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => configs }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => configs } }));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("~/state/rubatoHttp", () => ({
  postRubato: async (_environmentId: string, _route: string, action: string) =>
    action === "list" ? { prompts: LIBRARY } : {},
}));

import {
  openRubatoSessionPromptMenu,
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
    expect(rubatoSessionPromptAvailable(ENV, "draft", "codex")).toBe(false);
    expect(rubatoSessionPromptAvailable(ENV, null, "rubato")).toBe(false);
  });
});

describe("RubatoSessionPromptPicker", () => {
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
