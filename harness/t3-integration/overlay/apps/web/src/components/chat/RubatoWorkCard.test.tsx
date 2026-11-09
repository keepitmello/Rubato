import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const shells = new Map<string, unknown>();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => (ref ? (shells.get(ref.threadId) ?? null) : null),
}));
vi.mock("../../state/rubatoCompanion", () => ({ rubatoCompanion: { thread: async () => ({ threadId: null }) } }));

import { RubatoWorkCard } from "./RubatoWorkCard";

const launch = {
  tool: "create" as const,
  sessionId: "S2",
  title: "원화 출금 설계",
  model: "anthropic/claude-opus-5-5-sub",
  startsWork: true,
  error: null,
  pending: false,
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
