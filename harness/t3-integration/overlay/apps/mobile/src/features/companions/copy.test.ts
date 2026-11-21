import { describe, expect, it } from "vite-plus/test";

import { callsUserLine, copy, dateFormat, hasFinalConsonant, setCopyLocale, setCopyLocaleSource, sinceLine, withName } from "./copy";

describe("the profile's lines", () => {
  it("picks 라고 or 이라고 by the last sound", () => {
    expect(callsUserLine("오빠", "ko-KR")).toBe("나를 오빠라고 불러");
    expect(callsUserLine("형님", "ko-KR")).toBe("나를 형님이라고 불러");
    expect(callsUserLine("Wooyong", "ko-KR")).toBe("나를 Wooyong라고 불러");
    expect(callsUserLine("오빠", "en-US")).toBe("Calls you 오빠");
    expect(hasFinalConsonant("닭")).toBe(true);
    expect(hasFinalConsonant("")).toBe(false);
  });

  it("says since when in the phone's language, and nothing for a bad date", () => {
    expect(sinceLine("2026-10-20T03:00:00Z", "ko-KR")).toBe("10월 20일부터 함께");
    expect(sinceLine("2026-10-20T03:00:00Z", "en-US")).toBe("Together since October 20");
    expect(sinceLine("soon", "ko-KR")).toBeNull();
  });

  it("fills the name in", () => {
    expect(withName("{name}한테 그려 달라기", "세뇨")).toBe("세뇨한테 그려 달라기");
  });
});

describe("the language of the companion screens", () => {
  it("follows the app's language, read once, and a switch after", () => {
    let reads = 0;
    setCopyLocaleSource(() => {
      reads += 1;
      return "ko";
    });
    expect(copy.newCompanion).toBe("새 컴패니언");
    expect(copy.apply).toBe("적용");
    expect(reads).toBe(1);
    setCopyLocale("en-US");
    expect(copy.newCompanion).toBe("New companion");
    expect(dateFormat({ month: "long" }).resolvedOptions().locale).toBe("en-US");
    setCopyLocale("ko-KR");
    expect(dateFormat({ month: "long" }).format(Date.UTC(2026, 9, 20, 3))).toBe("10월");
  });
});
