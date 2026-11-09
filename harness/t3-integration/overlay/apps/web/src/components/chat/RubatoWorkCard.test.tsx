// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const shells = new Map<string, unknown>();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => (ref ? (shells.get(ref.threadId) ?? null) : null),
}));
const threads = vi.hoisted(() => new Map<string, string | null>());
vi.mock("../../state/rubatoCompanion", () => ({
  rubatoCompanion: { thread: async (env: string, sessionId: string) => ({ threadId: threads.get(`${env}:${sessionId}`) ?? null }) },
}));

import { act } from "react";
import { createRoot } from "react-dom/client";

import { RubatoWorkCard, useLaunchedThreadId } from "./RubatoWorkCard";

const launch = {
  tool: "create" as const,
  sessionId: "S2",
  title: "원화 출금 설계",
  model: "anthropic/claude-opus-5-5-sub",
  startsWork: true,
  error: null,
  pending: false,
  launchedAt: null,
};

describe("the work card", () => {
  it("shows the state word, the title and model, and keeps looking until the thread is found", () => {
    const html = renderToStaticMarkup(<RubatoWorkCard launch={launch} environmentId={"env" as never} />);
    expect(html).toContain('data-rubato-work-card="starting"');
    expect(html).toContain("Starting");
    expect(html).toContain("원화 출금 설계");
    expect(html).toContain("opus-5-5-sub");
    expect(html).toContain("Looking for the conversation");
    expect(html).not.toContain("Open thread");
  });

  it("shows a launch that failed with its reason and no Open", () => {
    const html = renderToStaticMarkup(
      <RubatoWorkCard launch={{ ...launch, sessionId: null, error: "Could not create a conversation in /nope" }} environmentId={"env" as never} />,
    );
    expect(html).toContain('data-rubato-work-card="failed"');
    expect(html).toContain("Could not create a conversation in /nope");
    expect(html).not.toContain("Open thread");
  });

  it("marks a fork", () => {
    const html = renderToStaticMarkup(<RubatoWorkCard launch={{ ...launch, tool: "fork", title: null }} environmentId={"env" as never} />);
    expect(html).toContain("· Fork");
    expect(html).toContain('data-rubato-work-card-tool="fork"');
  });
});

describe("finding the launched thread", () => {
  it("drops the thread it found once the card shows another conversation or environment", async () => {
    // @ts-expect-error React's act environment flag
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    threads.set("E:A", "thread-A");
    const seen: Array<string | null> = [];
    function Probe({ env, sessionId }: { env: string; sessionId: string }) {
      seen.push(useLaunchedThreadId(env as never, sessionId));
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe env="E" sessionId="A" />));
    await act(async () => {});
    expect(seen.at(-1)).toBe("thread-A");
    await act(async () => root.render(<Probe env="E" sessionId="B" />));
    expect(seen.at(-1), "another conversation").toBeNull();
    await act(async () => root.render(<Probe env="F" sessionId="A" />));
    expect(seen.at(-1), "the same conversation in another environment").toBeNull();
    act(() => root.unmount());
  });
});
