import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  RubatoSessionMessageBubble,
  rubatoNoticeLabel,
  rubatoSessionMessageHeading,
  rubatoSessionMessageOf,
} from "./RubatoSessionMessage";

/** The context the bridge attaches (harness/t3-integration/src/events.mjs sessionMessageFrom). */
const sessionContext = (kind: "message" | "create" | "notice" | "wake", title: string) => ({
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

describe("a notice from Rubato about a followed conversation", () => {
  it("is one quiet line naming the conversation and what happened", () => {
    const link = rubatoSessionMessageOf({ role: "user", context: sessionContext("notice", "결제 로그 점검") });
    expect(link?.kind).toBe("notice");
    const html = renderToStaticMarkup(
      <RubatoSessionMessageBubble link={link!} text={"Finished its turn.\n\nIts answer:\nAll fine."}>
        <p>body</p>
      </RubatoSessionMessageBubble>,
    );
    expect(html).toContain("data-rubato-session-notice");
    expect(html).toContain("결제 로그 점검");
    expect(html).toContain(">Finished<");
    expect(html).not.toContain("body");
  });
  it("says what happened in a word or two", () => {
    expect(rubatoNoticeLabel("Was stopped before finishing.")).toBe("Stopped");
    expect(rubatoNoticeLabel("Ended with an error.\n\nIts last words:\nx")).toBe("Failed");
    expect(rubatoNoticeLabel("Is waiting for the user to answer it (select).")).toBe("Asked you");
    expect(rubatoNoticeLabel("Stopped mid-turn without finishing: its runtime went away.")).toBe("Lost its runtime");
    expect(rubatoNoticeLabel("Something new happened. More text.")).toBe("Something new happened.");
  });
});

describe("Rubato's clock (a heartbeat, the daily report)", () => {
  it("is a session message of its own kind that draws nothing but a marker for its row", () => {
    const link = rubatoSessionMessageOf({ role: "user", context: sessionContext("wake", "Rubato") });
    expect(link?.kind).toBe("wake");
    const html = renderToStaticMarkup(
      <RubatoSessionMessageBubble link={link!} text="Heartbeat.">
        <p>Heartbeat.</p>
      </RubatoSessionMessageBubble>,
    );
    expect(html).toBe('<span data-rubato-wake="" hidden=""></span>');
  });
});
