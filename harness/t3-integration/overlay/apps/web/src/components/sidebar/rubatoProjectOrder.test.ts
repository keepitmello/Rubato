import { describe, expect, it } from "vite-plus/test";

import { inProjectOrder } from "./rubatoProjectOrder";

const entry = (projectKey: string, isPreferred = false) => ({ group: { projectKey }, isPreferred });
const ordered = ["a", "b", "c"].map((projectKey) => ({
  projectKey,
  memberProjectRefs: [{ environmentId: "env", projectId: projectKey }],
}));

describe("picker entries in the shared order", () => {
  it("puts the current project back where the user placed it", () => {
    // T3's picker lists the current project (c) first.
    const entries = [entry("c", true), entry("a"), entry("b")];
    expect(inProjectOrder(entries, ordered).map((e) => e.group.projectKey)).toEqual(["a", "b", "c"]);
  });

  it("keeps entries the order does not know at the end", () => {
    const entries = [entry("x"), entry("b"), entry("a")];
    expect(inProjectOrder(entries, ordered).map((e) => e.group.projectKey)).toEqual(["a", "b", "x"]);
  });
});
