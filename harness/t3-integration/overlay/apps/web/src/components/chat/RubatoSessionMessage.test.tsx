import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  RubatoSessionMessageBubble,
  rubatoSessionMessageHeading,
  rubatoSessionMessageOf,
} from "./RubatoSessionMessage";

/** The context the bridge attaches (harness/t3-integration/src/events.mjs sessionMessageFrom). */
const sessionContext = (kind: "message" | "create", title: string) => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: "rubato-session",
      kind: "rubato-session",
      label: title,
      payload: { v: 1, kind, messageId: "m-1", from: { sessionId: "sess-a", title, cwd: "/work" } },
    },
  ],
});

describe("a message from another conversation", () => {
  it("is recognised by its context record, and a typed prompt is not", () => {
    expect(
      rubatoSessionMessageOf({ role: "user", context: sessionContext("message", "Release notes") }),
    ).toEqual({ title: "Release notes", kind: "message", fromSessionId: "sess-a" });
    expect(rubatoSessionMessageOf({ role: "user" })).toBeNull();
    expect(
      rubatoSessionMessageOf({
        role: "user",
        context: { version: 1, records: [{ version: 1, contextId: "m", kind: "mention", label: "a", path: "/a" }] },
      }),
    ).toBeNull();
    expect(
      rubatoSessionMessageOf({ role: "assistant", context: sessionContext("message", "Release notes") }),
    ).toBeNull();
  });

  it("is headed by the sender's title, and a started conversation says who started it", () => {
    const link = rubatoSessionMessageOf({ role: "user", context: sessionContext("create", "Planner") });
    expect(link && rubatoSessionMessageHeading(link)).toBe("Started by Planner");
    const untitled = rubatoSessionMessageOf({ role: "user", context: sessionContext("message", "") });
    expect(untitled && rubatoSessionMessageHeading(untitled)).toBe("From another conversation");
  });

  it("draws on the left in a framed card, not the person's filled bubble on the right", () => {
    const markup = renderToStaticMarkup(
      <RubatoSessionMessageBubble link={{ title: "Release notes", kind: "message", fromSessionId: "sess-a" }}>
        <p>Please check the changelog.</p>
      </RubatoSessionMessageBubble>,
    );
    expect(markup).toContain('data-rubato-session-message="true"');
    expect(markup).toContain("items-start");
    expect(markup).not.toContain("items-end");
    expect(markup).not.toContain("bg-message");
    expect(markup).toContain("Release notes");
    expect(markup).toContain("Please check the changelog.");
  });
});
