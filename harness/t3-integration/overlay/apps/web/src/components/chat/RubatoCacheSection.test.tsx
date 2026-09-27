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

  it("leaves a warm ring alone and lists hit rate, lifetime and the warmer instead of the compaction note", () => {
    const markup = meterWith({
      state: "warm",
      hitPercent: 92,
      expiresAt: Date.now() + 2 * HOUR + 5 * 60_000,
      warming: { mode: "idle", enabled: true, hours: 4, active: true, until: Date.now() + HOUR },
    });
    expect(markup).not.toContain("var(--color-error)");
    expect(markup).toContain("Hit rate");
    expect(markup).toContain("92%");
    expect(markup).toMatch(/Warm · 2h [45]m left/);
    expect(markup).toContain("Refreshing until");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>4h</);
    expect(markup).not.toContain("compacts automatically");
    expect(markup).toContain('data-close-delay="150"');
  });

  it("keeps a nearly full context out of red while the cache is warm", () => {
    const markup = meterWith({ state: "warm", expiresAt: Date.now() + 2 * HOUR, warming: { mode: "idle", enabled: true, active: true } }, 195_000);
    expect(markup).not.toContain("var(--color-error)");
  });

  it("says whether this thread or the setting turned the warmer off", () => {
    const thread = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "idle", enabled: false, active: false } });
    expect(thread).toContain("Off for this thread");
    expect(thread).toMatch(/aria-pressed="true"[^>]*>Off</);
    expect(thread).not.toMatch(/data-disabled=""/);
    const global = meterWith({ state: "warm", sessionId: "s1", expiresAt: Date.now() + HOUR, warming: { mode: "off", enabled: true, active: false } });
    expect(global).toContain("Off in settings");
    expect(global).toMatch(/data-disabled=""/);
  });
});
