import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const checkedAt = new Date(NOW).toISOString();

function claude(instanceId: string, email: string, usedPercent: number, hoursUntilReset: number) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.0.0",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          windowDurationMins: 10080,
          resetsAt: new Date(NOW + hoursUntilReset * HOUR).toISOString(),
        },
      ],
    },
  } as ServerProvider;
}

const shown = (text: string) =>
  [...document.querySelectorAll("span")].some(
    (element) => element.textContent === text && element.checkVisibility(),
  );

describe("the Usage page's pace forecast", () => {
  it("tells each account when it runs out and colours its even-pace tick", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              claude("claude_a", "dali@example.com", 85, 46),
              claude("claude_b", "lea@example.com", 27, 70),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={NOW} />,
    );

    await expect.poll(() => shown("12% in deficit · Runs out in 21h 31m")).toBe(true);
    await expect.poll(() => shown("31% in reserve · Lasts until reset")).toBe(true);
    expect(screen.container.querySelector(".bg-destructive")).not.toBeNull();
    expect(screen.container.querySelector(".bg-success")).not.toBeNull();
  });
});
