import { type EnvironmentId, EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const HOUR = 60 * 60_000;

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

  it("leaves a warm ring alone and lists hit rate, lifetime and the warming hours instead of the compaction note", () => {
    const from = Date.now() - HOUR;
    const markup = meterWith({
      state: "warm",
      sessionId: "s1",
      hitPercent: 92,
      expiresAt: Date.now() + 2 * HOUR + 5 * 60_000,
      warming: { mode: "idle", enabled: true, hours: 4, from, active: true, until: from + 4 * HOUR },
    });
    expect(markup).not.toContain("var(--color-error)");
    expect(markup).toContain("Hit rate");
    expect(markup).toContain("92%");
    expect(markup).toMatch(/Warm · 2h [45]m left/);
    expect(markup).toContain(">4h<");
    expect(markup).toContain("until ");
    expect(markup).not.toContain("after your last message");
    expect(markup).not.toContain(">Off<");
    expect(markup).not.toContain("compacts automatically");
    expect(markup).toContain('data-close-delay="150"');
  });

  it("offers Stop while warming, and says stopped once it is", () => {
    const from = Date.now() - HOUR;
    const warming = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: true, hours: 2, from, active: true } });
    expect(warming).toContain("Stop warming this thread");
    const stopped = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: true, hours: 2, from, active: false, stopped: true } });
    expect(stopped).toContain(">stopped<");
    expect(stopped).not.toContain("Stop warming this thread");
  });

  it("says when a window already ended", () => {
    const from = Date.now() - 3 * HOUR;
    const markup = meterWith({ state: "cold", sessionId: "s1", warming: { mode: "idle", enabled: true, hours: 2, from, active: false } });
    expect(markup).toContain("ended ");
  });

  it("keeps a nearly full context out of red while the cache is warm", () => {
    const markup = meterWith({ state: "warm", expiresAt: Date.now() + 2 * HOUR, warming: { mode: "idle", enabled: true, active: true } }, 195_000);
    expect(markup).not.toContain("var(--color-error)");
  });

  it("locks the hours when warming is off in settings", () => {
    const markup = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "off", enabled: true, active: false } });
    expect(markup).toContain("Off in settings");
    expect(markup).toMatch(/aria-label="One hour more"[^>]*disabled=""|disabled=""[^>]*aria-label="One hour more"/);
  });
});
