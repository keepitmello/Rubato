import { describe, expect, it } from "vite-plus/test";

import { getProjectOrderKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId } from "@t3tools/contracts";

import { defaultProjectOrderKeys, inProjectOrder } from "./rubatoProjectOrder";

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

describe("the order a new thread's project is picked from", () => {
  const checkout = (environmentId: string, workspaceRoot: string) => ({
    environmentId: environmentId as EnvironmentId,
    workspaceRoot,
  });

  it("follows the shared order and offers every checkout of a project", () => {
    const groups = [
      { memberProjects: [checkout("mac", "/w/b")] },
      { memberProjects: [checkout("mac", "/w/a"), checkout("ssh", "/w/a")] },
    ];
    expect(defaultProjectOrderKeys(groups)).toEqual([
      getProjectOrderKey(checkout("mac", "/w/b")),
      getProjectOrderKey(checkout("mac", "/w/a")),
      getProjectOrderKey(checkout("ssh", "/w/a")),
    ]);
  });

  it("leaves out the no-project home", () => {
    const groups = [
      { isScratch: true, memberProjects: [checkout("mac", "/home/scratch")] },
      { memberProjects: [checkout("mac", "/w/a")] },
    ];
    expect(defaultProjectOrderKeys(groups)).toEqual([getProjectOrderKey(checkout("mac", "/w/a"))]);
  });
});
