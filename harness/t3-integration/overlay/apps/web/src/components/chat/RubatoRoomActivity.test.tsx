// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { RubatoCallCard } from "./RubatoCallCard";
import { useCompanionLiveWork } from "./RubatoSegnoInner";
import { useCompanionProposals } from "./RubatoCompanionProposals";
import { useRoomCalls, useRubatoCallRinging } from "../../state/rubatoCall";

const api = vi.hoisted(() => ({
  live: vi.fn(async (_env: string, _id: string, _signal: AbortSignal) => ({ work: "file" })),
  proposals: vi.fn(async () => ({ proposals: [] })),
  post: vi.fn(async (_env: string, _route: string, _action: string) => []),
}));
vi.mock("../../state/rubatoCompanion", () => ({
  rubatoCompanion: { live: api.live, proposals: api.proposals },
  useReadyEnvironmentId: () => "mac",
}));
vi.mock("../../state/rubatoHttp", () => ({ postRubato: api.post, RubatoRequestError: Error }));
vi.mock("../../composerDraftStore", () => ({}));
vi.mock("./RubatoCompanionFace", () => ({}));
vi.mock("../ui/toast", () => ({}));

it("pauses room reads when hidden but keeps listening for a call, then refreshes on return", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const env = EnvironmentId.make("mac");
  function Room() {
    useRubatoCallRinging((name) => name);
    useRoomCalls(env, "roo");
    useCompanionProposals(env, "roo", 0);
    return <span>{useCompanionLiveWork(env, "roo", true)}</span>;
  }
  const root = createRoot(document.createElement("div"));
  const change = (state: DocumentVisibilityState) => act(async () => {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  try {
    await act(async () => root.render(<Room />));
    expect(api.proposals).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.live).toHaveBeenCalledTimes(17);
    await change("hidden");
    expect(api.live.mock.calls.at(-1)?.[2].aborted).toBe(true);
    const counts = () => [api.live.mock.calls.length, api.proposals.mock.calls.length,
      api.post.mock.calls.filter(([, , action]) => action === "calls").length];
    const before = counts();
    const rings = api.post.mock.calls.filter(([, , action]) => action === "live").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(counts()).toEqual(before);
    expect(api.post.mock.calls.filter(([, , action]) => action === "live").length).toBeGreaterThan(rings);
    await change("visible");
    expect(counts()).toEqual(before.map((n) => n + 1));
  } finally {
    act(() => root.unmount());
    visibility.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("a closed call card does not read the transcript; opening it still shows both speakers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let reads = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<RubatoCallCard title="Roo" locale="en" call={{
      id: "a", companion: "roo", direction: "outgoing", status: "ended", reason: null,
      createdAt: 10, answeredAt: 10, endedAt: 20,
      get transcript() { reads++; return [{ who: "me" as const, text: "one", at: 10 }, { who: "companion" as const, text: "two", at: 20 }]; },
    }} />));
    expect(reads).toBe(0);
    await act(async () => host.querySelector("button")!.click());
    expect([...host.querySelectorAll("[data-rubato-call-line]")].map((el) => el.textContent)).toEqual(["one", "two"]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
