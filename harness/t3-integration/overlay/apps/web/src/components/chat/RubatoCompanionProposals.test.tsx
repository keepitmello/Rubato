// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  apply: vi.fn(),
  setPrompt: vi.fn(),
  focus: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("../../state/rubatoHttp", () => ({
  RubatoRequestError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock("../../state/rubatoCompanion", () => ({
  acceptCompanionAvatar: fake.accept,
  rubatoCompanion: {
    applyProposal: fake.apply,
    proposals: async () => ({ proposals: [] }),
    avatar: async () => ({ avatar: { url: "data:image/png;base64,NEW", version: 2 } }),
  },
}));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: { getState: () => ({ setPrompt: fake.setPrompt }) } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./RubatoCompanionFace", () => ({ focusRoomComposer: fake.focus }));

import { RubatoRequestError } from "../../state/rubatoHttp";
import type { CompanionProposal } from "../../state/rubatoCompanion";
import { RubatoOnboardingChips, RubatoProposalCard } from "./RubatoCompanionProposals";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => root.render(node));
  return host;
}

const proposal: CompanionProposal = {
  id: "p1",
  kind: "piece",
  createdAt: 1,
  status: "open",
  label: "세뇨는 이런 애야 › 말투",
  piece: "soul",
  before: "보통 한두 줄, 길어도 서너 줄.",
  after: "보통 한 줄, 길어도 두 줄.",
};

const buttonNamed = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)!;

it("shows the change as struck and added words, and Apply saves it through apply-proposal", async () => {
  const onUpdate = vi.fn();
  fake.apply.mockResolvedValue({ proposal: { ...proposal, status: "applied" } });
  const host = mount(
    <RubatoProposalCard proposal={proposal} companionId="segno" environmentId={"env" as never} threadId="t1" onUpdate={onUpdate} onRefresh={vi.fn()} />,
  );
  expect([...host.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["한두", "서너"]);
  expect([...host.querySelectorAll("ins")].map((node) => node.textContent)).toEqual(["한", "두"]);
  expect(host.textContent).toContain("세뇨는 이런 애야 › 말투");
  await act(async () => buttonNamed(host, "Apply").click());
  expect(fake.apply).toHaveBeenCalledWith("env", "segno", "p1");
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }));
});

it("Rewrite more only puts the caret in the composer; nothing is sent or saved", async () => {
  const host = mount(
    <RubatoProposalCard proposal={proposal} companionId="segno" environmentId={"env" as never} threadId="t1" onUpdate={vi.fn()} onRefresh={vi.fn()} />,
  );
  await act(async () => buttonNamed(host, "Rewrite more").click());
  expect(fake.focus).toHaveBeenCalled();
  expect(fake.apply).not.toHaveBeenCalled();
  expect(fake.setPrompt).not.toHaveBeenCalled();
});

it("a stale answer turns the card into a gentle ask-again that drafts the request", async () => {
  const onUpdate = vi.fn();
  fake.apply.mockRejectedValue(new RubatoRequestError("stale", "The excerpt moved."));
  const host = mount(
    <RubatoProposalCard proposal={proposal} companionId="segno" environmentId={"env" as never} threadId="t1" onUpdate={onUpdate} onRefresh={vi.fn()} />,
  );
  await act(async () => buttonNamed(host, "Apply").click());
  expect(onUpdate).toHaveBeenCalledWith({ ...proposal, status: "stale" });
  dispose?.();
  const stale = mount(
    <RubatoProposalCard proposal={{ ...proposal, status: "stale" }} companionId="segno" environmentId={"env" as never} threadId="t1" onUpdate={onUpdate} onRefresh={vi.fn()} />,
  );
  expect(buttonNamed(stale, "Apply")).toBeUndefined();
  await act(async () => buttonNamed(stale, "Ask again").click());
  expect(fake.setPrompt).toHaveBeenCalledTimes(1);
  expect(fake.focus).toHaveBeenCalled();
});

it("an avatar proposal shows the picture, and Apply makes it the app-set picture everywhere", async () => {
  fake.apply.mockResolvedValue({ proposal: { id: "a1", kind: "avatar", createdAt: 1, status: "applied", label: "새 프사" } });
  const host = mount(
    <RubatoProposalCard
      proposal={{ id: "a1", kind: "avatar", createdAt: 1, status: "open", label: "새 프사", image: { url: "data:image/png;base64,AA==" } }}
      companionId="roo"
      environmentId={"env" as never}
      threadId="t1"
      onUpdate={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  await act(async () => buttonNamed(host, "Apply").click());
  expect(fake.apply).toHaveBeenCalledWith("env", "roo", "a1");
  expect(fake.accept).toHaveBeenCalledWith("roo", { url: "data:image/png;base64,NEW", version: 2 }, true);
});

it("onboarding chips check the settled topics and mark the ones left for later", () => {
  const host = mount(
    <RubatoOnboardingChips onboarding={{ items: [{ key: "name", state: "set", value: "미루" }, { key: "look", state: "deferred" }] }} />,
  );
  const chips = [...host.querySelectorAll("[data-rubato-onboarding-chip]")];
  expect(chips.map((chip) => chip.getAttribute("data-rubato-onboarding-chip"))).toEqual([
    "name", "callsUser", "work", "relationship", "look", "speech", "closeness",
  ]);
  expect(chips[0]!.getAttribute("data-state")).toBe("set");
  expect(chips[0]!.querySelector("svg")).not.toBeNull();
  expect(chips[4]!.textContent).toContain("Later");
  expect(chips.filter((chip) => chip.hasAttribute("data-required"))).toHaveLength(4);
  dispose?.();
  expect(mount(<RubatoOnboardingChips onboarding={null} />).childElementCount).toBe(0);
});
