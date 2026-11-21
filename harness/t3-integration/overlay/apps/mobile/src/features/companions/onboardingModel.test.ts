import { describe, expect, it } from "vite-plus/test";

import { decodeOnboarding, ONBOARDING_KEYS, onboardingReady } from "./onboardingModel";

describe("a new companion's first conversation", () => {
  it("lists every topic once in chip order, a topic the Mac left out as open", () => {
    const onboarding = decodeOnboarding({
      items: [
        { key: "work", state: "set", value: " 풀스택 " },
        { key: "name", state: "set", value: "미루" },
        { key: "look", state: "deferred" },
        { key: "name", state: "open" },
        { key: "mood", state: "set" },
        { key: "speech", state: "??" },
      ],
    });
    expect(onboarding?.items.map((item) => item.key)).toEqual([...ONBOARDING_KEYS]);
    expect(onboarding?.items.map((item) => [item.key, item.state, item.value])).toEqual([
      ["name", "set", "미루"],
      ["callsUser", "open", null],
      ["work", "set", "풀스택"],
      ["relationship", "open", null],
      ["look", "deferred", null],
      ["speech", "open", null],
      ["closeness", "open", null],
    ]);
  });

  it("reads null once it settled, or from anything that is not one", () => {
    expect(decodeOnboarding(null)).toBeNull();
    expect(decodeOnboarding(undefined)).toBeNull();
    expect(decodeOnboarding({ items: "name" })).toBeNull();
    expect(decodeOnboarding("onboarding")).toBeNull();
  });

  it("is ready when the four it needs are set, whatever waits for later", () => {
    const set = (keys: string[]) =>
      decodeOnboarding({ items: keys.map((key) => ({ key, state: "set" })).concat([{ key: "look", state: "deferred" }]) })!;
    expect(onboardingReady(set(["name", "callsUser", "work", "relationship"]))).toBe(true);
    expect(onboardingReady(set(["name", "callsUser", "work"]))).toBe(false);
  });
});
