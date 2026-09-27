import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WarmArcGlyph } from "./RubatoWarmArc";

const HOUR = 3_600_000;
const offsetOf = (markup: string) => Number(markup.match(/stroke-dashoffset="([\d.]+)"/)?.[1]);

describe("the sidebar's warm arc", () => {
  it("fills by what is left of the hours this thread chose, not a fixed window", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    // One hour left: a quarter of a 4h thread, half of a 2h thread.
    const fourHours = offsetOf(renderToStaticMarkup(
      <WarmArcGlyph warming={{ sessionId: "a", hours: 4, from: now - 3 * HOUR, until: now + HOUR }} now={now} />,
    ));
    const twoHours = offsetOf(renderToStaticMarkup(
      <WarmArcGlyph warming={{ sessionId: "b", hours: 2, from: now - HOUR, until: now + HOUR }} now={now} />,
    ));
    const circumference = 2 * Math.PI * 4.5;
    expect(fourHours).toBeCloseTo(circumference * 0.75, 3);
    expect(twoHours).toBeCloseTo(circumference * 0.5, 3);
  });
});
