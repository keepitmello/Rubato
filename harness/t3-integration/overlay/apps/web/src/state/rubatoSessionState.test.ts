import { describe, expect, it } from "vite-plus/test";

import { EMPTY_SESSION_STATE, nextPollMs, type RubatoSessionAgent } from "./rubatoSessionState";

const agent = (status: RubatoSessionAgent["status"]): RubatoSessionAgent => ({
  taskId: `st_${status}`,
  title: status,
  status,
  startedAt: "2026-10-18T00:00:00Z",
  updatedAt: "2026-10-18T00:00:00Z",
});

describe("nextPollMs", () => {
  it("reads sooner while an agent works, so a settle shows within a second", () => {
    const resting = nextPollMs({ ...EMPTY_SESSION_STATE, agents: [agent("idle"), agent("completed")] });
    const working = nextPollMs({ ...EMPTY_SESSION_STATE, agents: [agent("idle"), agent("running")] });
    expect(working).toBeLessThan(resting);
    expect(working).toBeLessThanOrEqual(1_000);
    expect(nextPollMs(EMPTY_SESSION_STATE)).toBe(resting);
  });
});
