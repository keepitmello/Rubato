import { describe, expect, it } from "vite-plus/test";

import { callsUserLine, hasFinalConsonant, sinceLine, withName } from "./profileLines";

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
