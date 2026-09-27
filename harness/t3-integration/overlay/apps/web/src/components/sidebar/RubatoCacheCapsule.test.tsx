import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { CachedThread } from "~/state/rubatoCacheWarming";
import { CacheCapsuleGlyph, cacheTooltipLines } from "./RubatoCacheCapsule";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-27T12:00:00Z");
const widthOf = (markup: string) => Number(markup.match(/width[:=]"?([\d.]+)%/)?.[1]);
const thread = (over: Partial<CachedThread>): CachedThread => ({
  sessionId: "s",
  expiresAt: now + HOUR,
  from: now - HOUR,
  warmer: "off",
  ...over,
});

describe("the sidebar's cache capsule", () => {
  it("fills by what is left of the cache's life since the latest input, not the warmer's hours", () => {
    // Warmer on for 2h, 1h in, the cache lasting 1h past the warmer: 2h of 3h left.
    const warmed = renderToStaticMarkup(
      <CacheCapsuleGlyph cached={thread({ warmer: "on", hours: 2, until: now + HOUR, expiresAt: now + 2 * HOUR })} now={now} />,
    );
    expect(widthOf(warmed)).toBeCloseTo(66.667, 2);
    // No warmer: half of a cache that dies on its own.
    const plain = renderToStaticMarkup(<CacheCapsuleGlyph cached={thread({})} now={now} />);
    expect(widthOf(plain)).toBeCloseTo(50, 3);
  });

  it("carries the flame only while the warmer holds the cache", () => {
    const on = renderToStaticMarkup(<CacheCapsuleGlyph cached={thread({ warmer: "on", until: now + HOUR })} now={now} />);
    const ended = renderToStaticMarkup(<CacheCapsuleGlyph cached={thread({ warmer: "ended", until: now - 1 })} now={now} />);
    expect(on).toContain('data-warming="true"');
    expect(ended).not.toContain("data-warming");
  });

  it("tells how long the cache stays warm first, then what the warmer does", () => {
    const [cache, warmer] = cacheTooltipLines(
      thread({ warmer: "on", hours: 2, until: now + HOUR, expiresAt: now + 2 * HOUR + 18 * 60_000 }),
      now,
    );
    expect(cache).toBe("Cache warm · 2h 18m left");
    expect(warmer).toMatch(/^Warmer on until .+ · 2h$/);
    expect(cacheTooltipLines(thread({ warmer: "off" }), now)[1]).toBe("Warmer off");
  });
});
