import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RUBATO_LIVE_LINE_DWELL_MS, useRubatoLiveLine } from "./rubatoLiveLine";

function Line({ dwellKey, value }: { dwellKey: string | null; value: string }) {
  return <span>{useRubatoLiveLine(dwellKey, value)}</span>;
}

describe("useRubatoLiveLine", () => {
  let renderer: ReactTestRenderer;
  const shown = () => renderer.root.findByType("span").children.join("");
  const show = (dwellKey: string | null, value = dwellKey ?? "settled") =>
    act(() => renderer.update(<Line dwellKey={dwellKey} value={value} />));

  beforeEach(() => {
    vi.useFakeTimers();
    act(() => {
      renderer = create(<Line dwellKey="Reading a.ts" value="Reading a.ts" />);
    });
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.useRealTimers();
  });

  it("keeps a line up for a second before the next one replaces it", () => {
    show("Running npm test");
    expect(shown()).toBe("Reading a.ts");
    act(() => vi.advanceTimersByTime(RUBATO_LIVE_LINE_DWELL_MS - 1));
    expect(shown()).toBe("Reading a.ts");
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toBe("Running npm test");
  });

  it("skips a line that is replaced while it waits, so a moment between calls never shows", () => {
    show("Thinking");
    act(() => vi.advanceTimersByTime(300));
    show("Searching for foo");
    act(() => vi.advanceTimersByTime(RUBATO_LIVE_LINE_DWELL_MS));
    expect(shown()).toBe("Searching for foo");
  });

  it("changes at once after a line has been up long enough, and when the row settles", () => {
    act(() => vi.advanceTimersByTime(RUBATO_LIVE_LINE_DWELL_MS * 2));
    show("Running npm test");
    expect(shown()).toBe("Running npm test");
    show(null, "Read files and ran commands");
    expect(shown()).toBe("Read files and ran commands");
  });

  it("follows a new value under the same line at once", () => {
    show("Reading a.ts", "Reading a.ts (updated)");
    expect(shown()).toBe("Reading a.ts (updated)");
  });
});
