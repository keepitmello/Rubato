import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";
import { RubatoAgentSession } from "./RubatoAgentSession";

// The thread's timeline pulls in the diff worker, which a node test cannot load. What it
// draws for an agent is rubatoAgentTimeline.test.ts.
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));

describe("RubatoAgentSession", () => {
  it("opens on the header and a way back, and reads before it offers controls", () => {
    const html = renderToStaticMarkup(
      <RubatoAgentSession
        target={{
          environmentId: "env" as EnvironmentId,
          threadId: "thread-1",
          cwd: "/p",
          taskId: "st_a",
        }}
        live
        revision="running|t"
        header={<span>Review Q1-Q5</span>}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain("Back to agents");
    expect(html).toContain("Review Q1-Q5");
    expect(html).toContain("Loading the conversation…");
    // Controls appear once the server says the thread's session is running.
    expect(html).not.toContain("Message to this agent");
  });

  it("a thread with no folder says why there is nothing to read", () => {
    const html = renderToStaticMarkup(
      <RubatoAgentSession
        target={null}
        live={false}
        revision=""
        header={null}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain("This thread has no folder to read the agent from.");
  });
});
