import { describe, expect, it } from "@effect/vitest";

import type { UserMemoryAsk } from "../../state/rubatoMemory";
import {
  evidenceSource,
  failureText,
  itemBasis,
  justChanged,
  overviewLine,
  pollDelay,
  threadAsks,
  topicTitle,
  workingAsk,
} from "./RubatoUserMemory.logic";

const ask = (overrides: Partial<UserMemoryAsk>): UserMemoryAsk => ({
  id: "a",
  text: "왜?",
  focus: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  state: "done",
  result: { status: "done", changes: [], forgotten: [], finishedAt: "2026-10-29T00:01:00.000Z" },
  ...overrides,
});

describe("topics and sources read in words a person knows", () => {
  it("uses the curator's title, else the folder in words", () => {
    expect(topicTitle({ id: "preferences", title: "선호" })).toBe("선호");
    expect(topicTitle({ id: "working-style", title: null })).toBe("Working style");
    expect(topicTitle({ id: "", title: null })).toBe("Other");
  });
  it("names where a line came from without the record's syntax", () => {
    expect(evidenceSource({ raw: "", where: "project rubato-lab" })).toBe("Said in rubato-lab");
    expect(evidenceSource({ raw: "", where: "Settings > Memory" })).toBe("You told Rubato here");
    expect(evidenceSource({ raw: "", where: "legacy profile" })).toBe("Your old profile");
    expect(evidenceSource({ raw: "" })).toBe("Noticed in a conversation");
  });
  it("says how much a line rests on", () => {
    expect(itemBasis({ evidence: [] })).toBeNull();
    expect(itemBasis({ evidence: [{ raw: "", date: "2026-10-01", quote: "a" }, { raw: "", date: "2026-10-03", quote: "b" }] })).toBe("From 2 things you said · latest 2026-10-03");
    expect(itemBasis({ evidence: [{ raw: "", date: "2026-10-01" }] })).toBe("Last noted 2026-10-01");
  });
  it("counts what is remembered", () => {
    expect(overviewLine({ count: 0, topics: [] })).toBe("Nothing is remembered about you yet.");
    expect(overviewLine({ count: 3, topics: [{ id: "a", title: null, items: [] }, { id: "b", title: null, items: [] }] })).toBe("Rubato remembers 3 things about you, in 2 topics.");
  });
});

describe("following a request", () => {
  const idle = { running: false, lastAt: null, lastStatus: null, waiting: 0 };
  it("looks again often while a request works, slowly while a dream runs, else not at all", () => {
    expect(pollDelay(null)).toBeNull();
    expect(pollDelay({ asks: [ask({ state: "working", result: null })], dream: idle })).toBe(2_000);
    expect(pollDelay({ asks: [ask({})], dream: { ...idle, running: true } })).toBe(15_000);
    expect(pollDelay({ asks: [ask({})], dream: idle })).toBeNull();
    expect(workingAsk([ask({}), ask({ id: "b", state: "working", result: null })])?.id).toBe("b");
  });
  it("marks in the list only what the newest finished request changed, never a forgotten line", () => {
    const changes = [
      { path: "p/a.md", topic: "p", change: "modified" as const, before: "x", after: "y" },
      { path: "p/b.md", topic: "p", change: "deleted" as const, before: "z" },
    ];
    const latest = ask({ result: { status: "done", changes, forgotten: [], finishedAt: "t" } });
    expect([...justChanged([latest]).keys()]).toEqual(["p/a.md"]);
    expect(justChanged([ask({ id: "new", state: "failed", result: null }), latest]).size).toBe(0);
  });
  it("explains a failure in plain words and keeps an unknown reason as it is", () => {
    expect(failureText(ask({ state: "busy", result: null }))).toBe("Another request was still being handled.");
    expect(failureText(ask({ state: "failed", result: { status: "failed", changes: [], forgotten: [], finishedAt: "t", reason: "the forgotten claim is still in a.md" } }))).toBe("It could not remove every copy of that, so nothing was forgotten.")
    expect(failureText(ask({ state: "failed", result: { status: "failed", changes: [], forgotten: [], finishedAt: "t", reason: "provider said no\nstack" } }))).toBe("provider said no");
  });
});

describe("the request thread", () => {
  const at = (minutes: number) => new Date(Date.parse("2026-10-29T00:00:00.000Z") + minutes * 60_000).toISOString();
  const now = Date.parse("2026-10-29T01:00:00.000Z");
  it("puts what was sent here, what works and a fresh unretried failure first; history folds", () => {
    const asks = [
      ask({ id: "retry", text: "기억해", createdAt: at(30) }),
      ask({ id: "failed-then-retried", text: "기억해", state: "failed", createdAt: at(20) }),
      ask({ id: "fresh-failure", text: "잊어", state: "failed", createdAt: at(10) }),
      ask({ id: "working", state: "working", result: null, createdAt: at(5) }),
      ask({ id: "inline", focus: { path: "p/a.md" }, createdAt: at(4) }),
      ask({ id: "old", createdAt: at(-600) }),
      ask({ id: "old-failure", state: "failed", text: "x", createdAt: at(-60 * 48) }),
    ];
    const { current, earlier } = threadAsks(asks, new Set(["retry", "inline"]), new Set(["inline"]), now);
    expect(current.map((entry) => entry.id)).toEqual(["retry", "fresh-failure", "working"]);
    expect(earlier.map((entry) => entry.id)).toEqual(["old", "old-failure"]);
  });
});
