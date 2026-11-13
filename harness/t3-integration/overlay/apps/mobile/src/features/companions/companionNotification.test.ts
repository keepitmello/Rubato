import { describe, expect, it } from "vite-plus/test";

import { companionNotificationLink } from "./companionNotification";

describe("a companion message notification", () => {
  it("opens that companion's room, with its Mac and thread when the push names them", () => {
    expect(companionNotificationLink({ rubato: { kind: "companion-message", companionId: "roo", environmentId: "env 1", threadId: "t1" } }))
      .toBe("/companions/roo?environmentId=env+1&threadId=t1");
    expect(companionNotificationLink({ rubato: { kind: "companion-message", companionId: "segno" } })).toBe("/companions/segno");
  });

  it("leaves every other notification to the app's own routing", () => {
    expect(companionNotificationLink({ rubato: { kind: "thread", threadId: "t1" } })).toBeNull();
    expect(companionNotificationLink({ environmentId: "e", threadId: "t" })).toBeNull();
    expect(companionNotificationLink(null)).toBeNull();
  });
});
