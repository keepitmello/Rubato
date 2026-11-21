import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { paceForecast, paceForecastText } from "./rubatoUsagePace";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function weekly(usedPercent: number, hoursUntilReset: number, minutes?: number) {
  return {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: new Date(NOW + hoursUntilReset * HOUR).toISOString(),
    ...(minutes === undefined ? {} : { windowDurationMins: minutes }),
  } as ServerProviderUsageWindow;
}

const clock = (ms: number) => `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / 60_000)}m`;

describe("paceForecast", () => {
  it("matches CodexBar's card: 15% left with 46h to go is 12% in deficit, empty in 21h 31m", () => {
    const forecast = paceForecast(weekly(85, 46, 10080), NOW)!;
    expect(forecast.stage).toBe("deficit");
    expect(forecast.deltaPercent).toBe(12);
    expect(clock(forecast.runsOutInMs!)).toBe("21h 31m");
    expect(paceForecastText(forecast, "ko", clock)).toBe("12% 부족 · 21h 31m 후 소진");
    expect(paceForecastText(forecast, "en-US", clock)).toBe("12% in deficit · Runs out in 21h 31m");
  });

  it("says the window lasts when the speed so far reaches the reset with quota left", () => {
    const forecast = paceForecast(weekly(27, 70, 10080), NOW)!;
    expect(forecast.stage).toBe("reserve");
    expect(forecast.runsOutInMs).toBeNull();
    expect(paceForecastText(forecast, "ko", clock)).toBe("31% 여유 · 재설정까지 유지");
  });

  it("calls a spend within two points of the clock on pace", () => {
    const forecast = paceForecast(weekly(49, 84, 10080), NOW)!;
    expect(forecast.stage).toBe("on");
    expect(paceForecastText(forecast, "ko", clock)).toBe("정상 속도 · 재설정까지 유지");
  });

  it("takes a week for a weekly window that does not report its length", () => {
    expect(paceForecast(weekly(85, 46), NOW)?.deltaPercent).toBe(12);
    expect(paceForecast({ ...weekly(85, 46), kind: "monthly" }, NOW)).toBeNull();
  });

  it("says nothing without a clock, early in the window, or once the window is empty", () => {
    expect(paceForecast({ ...weekly(10, 46, 10080), resetsAt: undefined }, NOW)).toBeNull();
    expect(paceForecast(weekly(1, 167, 10080), NOW)).toBeNull();
    expect(paceForecast(weekly(100, 46, 10080), NOW)).toBeNull();
    expect(paceForecast(weekly(10, 200, 10080), NOW)).toBeNull();
  });

  it("lets an untouched window last", () => {
    expect(paceForecast(weekly(0, 46, 10080), NOW)).toMatchObject({
      stage: "reserve",
      lastsUntilReset: true,
    });
  });
});
