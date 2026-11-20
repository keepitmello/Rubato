import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RubatoCacheSection, warmingLeft } from "./RubatoCacheSection";

const HOUR = 60 * 60_000;
/** The warmer switch's state as the server render marks it. */
const switchOf = (markup: string) => markup.match(/<[^>]*data-(checked|unchecked)=""[^>]*role="switch"/)?.[1];

function sectionWith(cache: Record<string, unknown>) {
  return renderToStaticMarkup(
    <RubatoCacheSection cache={cache as never} environmentId={"env" as EnvironmentId} />,
  );
}

describe("the prompt cache in Thread details", () => {
  it("marks a cold cache in the error color", () => {
    const markup = sectionWith({ state: "cold", hitPercent: 92, warming: { mode: "idle", enabled: true, active: false } });
    expect(markup).toContain("var(--color-error)");
    expect(markup).toContain("Cold");
  });

  it("lists hit rate, lifetime and the hours left to warm for a warm cache", () => {
    const from = Date.now() - HOUR;
    const markup = sectionWith({
      state: "warm",
      sessionId: "s1",
      hitPercent: 92,
      expiresAt: Date.now() + 2 * HOUR + 5 * 60_000,
      warming: { mode: "idle", enabled: true, from, active: true, until: from + 4 * HOUR },
    });
    expect(markup).not.toContain("var(--color-error)");
    expect(markup).toContain("Hit rate");
    expect(markup).toContain("92%");
    expect(markup).toMatch(/Warm · 2h [45]m left/);
    expect(markup).toContain(">3h<");
    expect(markup).toContain("until ");
    expect(markup).not.toContain(">Off<");
  });

  it("switches this thread's warmer, with the hours and end time only while it is on", () => {
    const from = Date.now() - HOUR;
    const on = sectionWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: true, from, active: true, until: from + 3 * HOUR } });
    expect(switchOf(on)).toBe("checked");
    expect(on).toContain(">2h<");
    expect(on).toContain("until ");
    const off = sectionWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: false, from, active: false, until: from + 3 * HOUR } });
    expect(switchOf(off)).toBe("unchecked");
    expect(off).not.toContain(">2h<");
    expect(off).not.toContain("until ");
  });

  it("says when a window already ended, with nothing left to shorten", () => {
    const from = Date.now() - 3 * HOUR;
    const markup = sectionWith({ state: "cold", sessionId: "s1", warming: { mode: "idle", enabled: true, from, active: false, until: from + 2 * HOUR } });
    expect(markup).toContain("ended ");
    expect(markup).toContain(">0h<");
    expect(markup).toMatch(/aria-label="One hour less"[^>]*disabled/);
  });

  it("does not count from an old message when agent turns kept the cache warm", () => {
    // The latest message was 9 hours ago; the warmer's window ended 7 hours ago, yet a wake
    // turn rewrote the cache a minute ago. The stepper starts from now, not from that message.
    const from = Date.now() - 9 * HOUR;
    const markup = sectionWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + 58 * 60_000, warming: { mode: "idle", enabled: true, from, active: false, until: from + 2 * HOUR } });
    expect(markup).toContain("Warm · 5");
    expect(markup).toContain(">0h<");
    expect(markup).not.toMatch(/aria-label="One hour more"[^>]*disabled/);
  });

  it("tells a cold thread with the warmer on that the next message warms it", () => {
    const from = Date.now() - 3 * HOUR;
    const markup = sectionWith({ state: "cold", sessionId: "s1", warming: { mode: "idle", enabled: true, from, active: false, until: Date.now() + HOUR } });
    expect(markup).toContain("Warms again after your next message.");
  });

  it("locks the switch and hides the hours when warming is off in settings", () => {
    const markup = sectionWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "off", enabled: true, active: false } });
    expect(markup).toContain("Off in settings");
    expect(switchOf(markup)).toBe("unchecked");
    expect(markup).not.toContain(">1h<");
  });
});

describe("the hours left to warm", () => {
  const now = 1_790_000_000_000;
  it("rounds to whole hours from one hour up and shows minutes under it", () => {
    expect(warmingLeft(now + 3 * HOUR - 60_000, now)).toEqual({ label: "3h", base: 3 });
    expect(warmingLeft(now + HOUR + 20 * 60_000, now)).toEqual({ label: "1h", base: 1 });
    expect(warmingLeft(now + 45 * 60_000, now)).toEqual({ label: "45m", base: 1 });
  });
  it("is nothing once the window ended or before there is one", () => {
    expect(warmingLeft(now - 1, now)).toEqual({ label: "0h", base: 0 });
    expect(warmingLeft(undefined, now)).toEqual({ label: "0h", base: 0 });
  });
});
