import { describe, expect, it } from "vite-plus/test";

import { isDefaultBranchName } from "./rubatoDefaultBranch";

describe("isDefaultBranchName", () => {
  it("treats main and master as the default branch the card leaves unnamed", () => {
    expect(isDefaultBranchName("main")).toBe(true);
    expect(isDefaultBranchName("master")).toBe(true);
  });

  it("keeps every other branch on the card", () => {
    expect(isDefaultBranchName("feat/stats-page")).toBe(false);
    expect(isDefaultBranchName("main-fix")).toBe(false);
    expect(isDefaultBranchName("Main")).toBe(false);
  });
});
