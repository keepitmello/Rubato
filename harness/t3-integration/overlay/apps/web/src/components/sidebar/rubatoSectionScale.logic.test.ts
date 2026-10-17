import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SECTION_SCALES,
  SECTION_PARTS,
  SECTION_SCALE_DEFAULT,
  SECTION_SCALE_MAX,
  SECTION_SCALE_MIN,
  SECTION_SCALE_STEP,
  SECTION_SCALE_STORAGE_KEY,
  applySectionScaleCommand,
  clampSectionScale,
  readSectionScales,
  resolveHoveredSectionPart,
  resolveSectionScaleCommand,
  sectionScaleNotice,
  sectionScaleVariable,
  sectionScaleVariables,
  sectionScalesFromStored,
  sectionScalesToStored,
  setSectionScale,
  writeSectionScales,
  type SectionScaleKey,
} from "./rubatoSectionScale.logic";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

function key(overrides: Partial<SectionScaleKey>): SectionScaleKey {
  return { key: "", code: "", ctrlKey: false, altKey: false, metaKey: false, ...overrides };
}

describe("section scale range", () => {
  it("runs 80% to 150% in 10% steps around 100%", () => {
    expect([
      SECTION_SCALE_MIN,
      SECTION_SCALE_MAX,
      SECTION_SCALE_STEP,
      SECTION_SCALE_DEFAULT,
    ]).toEqual([80, 150, 10, 100]);
  });

  it("covers the seven parts, each at 100% by default", () => {
    expect(SECTION_PARTS.map((part) => part.id)).toEqual([
      "rail",
      "title",
      "recent",
      "cards",
      "homeTabs",
      "homeThreads",
      "messages",
    ]);
    expect(Object.values(DEFAULT_SECTION_SCALES)).toEqual(Array(7).fill(100));
  });

  it("snaps to the step and clamps to the range", () => {
    expect(clampSectionScale(114)).toBe(110);
    expect(clampSectionScale(115)).toBe(120);
    expect(clampSectionScale(40)).toBe(80);
    expect(clampSectionScale(400)).toBe(150);
    expect(clampSectionScale(Number.NaN)).toBe(100);
  });
});

describe("applySectionScaleCommand", () => {
  it("grows and shrinks one part by one step and leaves the others", () => {
    const grown = applySectionScaleCommand(DEFAULT_SECTION_SCALES, "recent", "grow");
    expect(grown).toEqual({ ...DEFAULT_SECTION_SCALES, recent: 110 });
    expect(applySectionScaleCommand(grown, "recent", "shrink")).toEqual(DEFAULT_SECTION_SCALES);
  });

  it("stops at the ends of the range", () => {
    const largest = setSectionScale(DEFAULT_SECTION_SCALES, "cards", 150);
    expect(applySectionScaleCommand(largest, "cards", "grow")).toBe(largest);
    const smallest = setSectionScale(DEFAULT_SECTION_SCALES, "cards", 80);
    expect(applySectionScaleCommand(smallest, "cards", "shrink")).toBe(smallest);
  });

  it("resets a part to 100%", () => {
    const scaled = setSectionScale(DEFAULT_SECTION_SCALES, "messages", 130);
    expect(applySectionScaleCommand(scaled, "messages", "reset")).toEqual(DEFAULT_SECTION_SCALES);
  });

  it("snaps slider values into the range", () => {
    expect(setSectionScale(DEFAULT_SECTION_SCALES, "rail", 173).rail).toBe(150);
  });
});

describe("persistence", () => {
  it("keeps only the parts off 100% and reads them back", () => {
    const storage = memoryStorage();
    const scales = setSectionScale(
      setSectionScale(DEFAULT_SECTION_SCALES, "recent", 110),
      "rail",
      90,
    );
    writeSectionScales(storage, scales);
    expect(sectionScalesToStored(scales)).toEqual({ rail: 90, recent: 110 });
    expect(readSectionScales(storage)).toEqual(scales);
  });

  it("removes the entry when every part is back at 100%", () => {
    const storage = memoryStorage({ [SECTION_SCALE_STORAGE_KEY]: '{"recent":110}' });
    writeSectionScales(storage, DEFAULT_SECTION_SCALES);
    expect(storage.items.has(SECTION_SCALE_STORAGE_KEY)).toBe(false);
  });

  it("reads a missing, unreadable or odd entry as safe scales", () => {
    expect(readSectionScales(memoryStorage())).toEqual(DEFAULT_SECTION_SCALES);
    expect(readSectionScales(memoryStorage({ [SECTION_SCALE_STORAGE_KEY]: "not json" }))).toEqual(
      DEFAULT_SECTION_SCALES,
    );
    expect(sectionScalesFromStored({ recent: 113, rail: 999, gone: 120 })).toEqual({
      ...DEFAULT_SECTION_SCALES,
      recent: 110,
      rail: 150,
    });
  });
});

describe("resolveSectionScaleCommand", () => {
  it("takes Ctrl + / Ctrl − / Ctrl 0 on the Mac", () => {
    expect(resolveSectionScaleCommand(key({ ctrlKey: true, key: "=", code: "Equal" }), true)).toBe(
      "grow",
    );
    expect(resolveSectionScaleCommand(key({ ctrlKey: true, key: "+", code: "Equal" }), true)).toBe(
      "grow",
    );
    expect(resolveSectionScaleCommand(key({ ctrlKey: true, key: "-", code: "Minus" }), true)).toBe(
      "shrink",
    );
    expect(resolveSectionScaleCommand(key({ ctrlKey: true, key: "0", code: "Digit0" }), true)).toBe(
      "reset",
    );
  });

  it("leaves ⌘ +/- and ⌘ 0 to the window zoom", () => {
    expect(
      resolveSectionScaleCommand(key({ metaKey: true, key: "=", code: "Equal" }), true),
    ).toBeNull();
    expect(
      resolveSectionScaleCommand(
        key({ metaKey: true, ctrlKey: true, key: "=", code: "Equal" }),
        true,
      ),
    ).toBeNull();
    expect(
      resolveSectionScaleCommand(key({ metaKey: true, key: "0", code: "Digit0" }), true),
    ).toBeNull();
  });

  it("needs Ctrl+Alt off the Mac, where Ctrl +/- is the window zoom", () => {
    expect(
      resolveSectionScaleCommand(key({ ctrlKey: true, key: "=", code: "Equal" }), false),
    ).toBeNull();
    expect(
      resolveSectionScaleCommand(
        key({ ctrlKey: true, altKey: true, key: "=", code: "Equal" }),
        false,
      ),
    ).toBe("grow");
    expect(
      resolveSectionScaleCommand(
        key({ ctrlKey: true, altKey: true, key: "–", code: "Minus" }),
        false,
      ),
    ).toBe("shrink");
    expect(
      resolveSectionScaleCommand(
        key({ ctrlKey: true, altKey: true, key: "=", code: "Equal" }),
        true,
      ),
    ).toBeNull();
  });

  it("ignores other keys", () => {
    expect(
      resolveSectionScaleCommand(key({ ctrlKey: true, key: "g", code: "KeyG" }), true),
    ).toBeNull();
    expect(resolveSectionScaleCommand(key({ key: "=", code: "Equal" }), true)).toBeNull();
  });
});

describe("resolveHoveredSectionPart", () => {
  it("names the part whose root is under the pointer", () => {
    const hovered = new Set(['[data-rubato-section="cards"]']);
    expect(resolveHoveredSectionPart((selector) => hovered.has(selector))?.id).toBe("cards");
    expect(resolveHoveredSectionPart(() => false)).toBeNull();
  });

  it("gives every part its own root", () => {
    expect(new Set(SECTION_PARTS.map((part) => part.selector)).size).toBe(SECTION_PARTS.length);
  });
});

describe("presentation", () => {
  it("words the notice as the part and its percent", () => {
    const recent = SECTION_PARTS.find((part) => part.id === "recent")!;
    expect(sectionScaleNotice(recent, 110)).toBe("Recent 110%");
  });

  it("hands the CSS one factor per part", () => {
    expect(sectionScaleVariable("homeThreads")).toBe("--rubato-scale-home-threads");
    expect(
      sectionScaleVariables(setSectionScale(DEFAULT_SECTION_SCALES, "recent", 120)),
    ).toMatchObject({
      "--rubato-scale-recent": "1.2",
      "--rubato-scale-rail": "1",
    });
  });
});
