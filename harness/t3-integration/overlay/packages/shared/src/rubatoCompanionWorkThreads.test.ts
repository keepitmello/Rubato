import { expect, it } from "vite-plus/test";

import { withoutCompanionWorkThreads } from "./rubatoCompanionWorkThreads.ts";

it("hides only registered work on the Mac that launched it, without changing thread data", () => {
  const work = { environmentId: "mac", id: "import:rubato:engine:lead" };
  const otherMac = { ...work, environmentId: "other" };
  const ownImport = { ...work, id: "import:rubato:engine:personal" };
  const ownThread = { ...work, id: "personal:lead" };
  const threads = [work, otherMac, ownImport, ownThread];
  const launches = new Map([["mac", new Set(["lead"])]]);
  expect(withoutCompanionWorkThreads(threads, launches, false)).toEqual([otherMac, ownImport, ownThread]);
  expect(withoutCompanionWorkThreads(threads, launches, true)).toBe(threads);
  expect(withoutCompanionWorkThreads(threads, new Map(), false)).toBe(threads);
});
