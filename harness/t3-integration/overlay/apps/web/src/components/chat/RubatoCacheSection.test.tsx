import { type EnvironmentId, EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { warmingLeft } from "./RubatoCacheSection";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const HOUR = 60 * 60_000;
/** The warmer switch's state as the server render marks it. */
const switchOf = (markup: string) => markup.match(/<[^>]*data-(checked|unchecked)=""[^>]*role="switch"/)?.[1];

function meterWith(cache: Record<string, unknown>, usedTokens = 10_000) {
  const usage = deriveLatestContextWindowSnapshot([
    {
      id: EventId.make("activity-1"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context updated",
      payload: { usedTokens, maxTokens: 200_000, compactsAutomatically: true, cache },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-09-27T03:00:00.000Z",
    },
  ]);
  if (!usage) throw new Error("The fixture did not produce a snapshot.");
  return renderToStaticMarkup(
    <ContextWindowMeter usage={usage} modelDisplayName="Opus 5.5" environmentId={"env" as EnvironmentId} />,
  );
}

describe("the context ring's prompt cache", () => {
  it("paints the ring red when the cache is cold", () => {
    const markup = meterWith({ state: "cold", hitPercent: 92, warming: { mode: "idle", enabled: true, active: false } });
    expect(markup).toContain('stroke="var(--color-error)"');
    expect(markup).toContain("Cold");
  });

  it("leaves a warm ring alone and lists hit rate, lifetime and the hours left to warm instead of the compaction note", () => {
    const from = Date.now() - HOUR;
    const markup = meterWith({
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
    expect(markup).not.toContain("after your last message");
    expect(markup).not.toContain(">Off<");
    expect(markup).not.toContain("compacts automatically");
    expect(markup).toContain('data-close-delay="150"');
  });

  it("switches this thread's warmer, with the hours and end time only while it is on", () => {
    const from = Date.now() - HOUR;
    const on = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: true, from, active: true, until: from + 3 * HOUR } });
    expect(switchOf(on)).toBe("checked");
    expect(on).toContain(">2h<");
    expect(on).toContain("until ");
    const off = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: false, from, active: false, until: from + 3 * HOUR } });
    expect(switchOf(off)).toBe("unchecked");
    expect(off).not.toContain(">2h<");
    expect(off).not.toContain("until ");
  });

  it("puts the prompt cache above the context window", () => {
    const markup = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: true, active: true } });
    expect(markup.indexOf("Prompt Cache")).toBeLessThan(markup.indexOf("Context Window"));
  });

  it("says when a window already ended, with nothing left to shorten", () => {
    const from = Date.now() - 3 * HOUR;
    const markup = meterWith({ state: "cold", sessionId: "s1", warming: { mode: "idle", enabled: true, from, active: false, until: from + 2 * HOUR } });
    expect(markup).toContain("ended ");
    expect(markup).toContain(">0h<");
    expect(markup).toMatch(/aria-label="One hour less"[^>]*disabled/);
  });

  it("does not count from an old message when agent turns kept the cache warm", () => {
    // The latest message was 9 hours ago; the warmer's window ended 7 hours ago, yet a wake
    // turn rewrote the cache a minute ago. The stepper starts from now, not from that message.
    const from = Date.now() - 9 * HOUR;
    const markup = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + 58 * 60_000, warming: { mode: "idle", enabled: true, from, active: false, until: from + 2 * HOUR } });
    expect(markup).toContain("Warm · 5");
    expect(markup).toContain(">0h<");
    expect(markup).not.toMatch(/aria-label="One hour more"[^>]*disabled/);
  });

  it("tells a cold thread with the warmer on that the next message warms it", () => {
    const from = Date.now() - 3 * HOUR;
    const markup = meterWith({ state: "cold", sessionId: "s1", warming: { mode: "idle", enabled: true, from, active: false, until: Date.now() + HOUR } });
    expect(markup).toContain("Warms again after your next message.");
  });

  it("keeps a nearly full context out of red while the cache is warm", () => {
    const markup = meterWith({ state: "warm", expiresAt: Date.now() + 2 * HOUR, warming: { mode: "idle", enabled: true, active: true } }, 195_000);
    expect(markup).not.toContain("var(--color-error)");
  });

  it("locks the switch and hides the hours when warming is off in settings", () => {
    const markup = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "off", enabled: true, active: false } });
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
