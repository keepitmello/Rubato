import { describe, expect, it } from "vite-plus/test";

import { companionNotificationOnScreen } from "./companionNotifications";

const message = { rubato: { kind: "companion-message", companionId: "roo", environmentId: "mac", threadId: "t1" } };

describe("companionNotificationOnScreen", () => {
  it("is quiet only in that companion's own room", () => {
    expect(companionNotificationOnScreen(message, "/companions/roo")).toBe(true);
    expect(companionNotificationOnScreen(message, "/companions/roo?environmentId=mac")).toBe(true);
    expect(companionNotificationOnScreen(message, "/companions/segno")).toBe(false);
    expect(companionNotificationOnScreen(message, "/threads/mac/t1")).toBe(false);
    expect(companionNotificationOnScreen(message, null)).toBe(false);
  });

  it("leaves thread alerts to T3", () => {
    expect(companionNotificationOnScreen({ environmentId: "mac", threadId: "t1" }, "/companions/roo")).toBe(false);
  });
});
