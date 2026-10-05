import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_FILE_NAVIGATION_HISTORY,
  FILE_NAVIGATION_HISTORY_LIMIT,
  stepFileNavigation,
  useFileNavigationStore,
  visitFileNavigation,
} from "./fileNavigationHistory";

const visitAll = (paths: string[]) =>
  paths.reduce(visitFileNavigation, EMPTY_FILE_NAVIGATION_HISTORY);

describe("file navigation history", () => {
  beforeEach(() => useFileNavigationStore.setState({ byKey: {} }));

  it("goes back and forward through visited paths", () => {
    const history = visitAll(["a.md", "b.md", "c.md"]);
    const back = stepFileNavigation(history, -1);
    expect(back.entries[back.index]).toBe("b.md");
    const forward = stepFileNavigation(back, 1);
    expect(forward.entries[forward.index]).toBe("c.md");
  });

  it("stays put at either end", () => {
    const history = visitAll(["a.md"]);
    expect(stepFileNavigation(history, -1)).toBe(history);
    expect(stepFileNavigation(history, 1)).toBe(history);
  });

  it("drops the forward entries when a new path is opened after going back", () => {
    const back = stepFileNavigation(visitAll(["a.md", "b.md", "c.md"]), -1);
    const branched = visitFileNavigation(back, "d.md");
    expect(branched.entries).toEqual(["a.md", "b.md", "d.md"]);
    expect(stepFileNavigation(branched, 1)).toBe(branched);
  });

  it("ignores showing the current path again", () => {
    const history = visitAll(["a.md", "a.md"]);
    expect(history.entries).toEqual(["a.md"]);
  });

  it("keeps only the most recent entries", () => {
    const paths = Array.from({ length: FILE_NAVIGATION_HISTORY_LIMIT + 5 }, (_, i) => `${i}.md`);
    const history = visitAll(paths);
    expect(history.entries).toHaveLength(FILE_NAVIGATION_HISTORY_LIMIT);
    expect(history.entries.at(-1)).toBe(paths.at(-1));
  });

  it("does not record the path a back step opens as a new visit", () => {
    const store = useFileNavigationStore.getState();
    for (const path of ["a.md", "b.md", "c.md"]) store.visit("thread", path);
    const target = store.step("thread", -1);
    expect(target).toBe("b.md");
    // The panel then shows b.md and reports it; forward must still reach c.md.
    store.visit("thread", "b.md");
    expect(store.step("thread", 1)).toBe("c.md");
  });

  it("keeps each panel's history apart", () => {
    const store = useFileNavigationStore.getState();
    store.visit("one", "a.md");
    store.visit("one", "b.md");
    store.visit("two", "x.md");
    expect(store.step("two", -1)).toBeNull();
    expect(store.step("one", -1)).toBe("a.md");
  });
});
