import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";
import { RubatoAgentSession, toolSummary } from "./RubatoAgentSession";

const tool = (name: string, input: string) => ({ kind: "tool" as const, id: "c", name, input });

describe("RubatoAgentSession", () => {
  it("a folded tool call names the tool and what it was given", () => {
    expect(toolSummary(tool("read", JSON.stringify({ path: "src/app.ts", offset: 4 })))).toBe(
      "read · src/app.ts",
    );
    expect(toolSummary(tool("bash", JSON.stringify({ command: "bun test\\nmore" })))).toBe(
      "bash · bun test\\nmore",
    );
    expect(toolSummary(tool("bash", JSON.stringify({ command: "bun test\nmore" })))).toBe(
      "bash · bun test",
    );
    expect(toolSummary(tool("todo", JSON.stringify({ op: "view" })))).toBe("todo");
    expect(toolSummary(tool("raw", "plain text input"))).toBe("raw · plain text input");
  });

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
