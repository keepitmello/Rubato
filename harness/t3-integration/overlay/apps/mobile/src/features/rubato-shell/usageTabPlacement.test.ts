import { describe, expect, it } from "vite-plus/test";

import { placeUsageTab } from "./usageTabPlacement";

describe("placeUsageTab", () => {
  it("shows Usage and puts it after the first two tabs on the bar", () => {
    expect(
      placeUsageTab({
        navigationTabOrder: ["companions", "threads", "pullRequests", "issues", "usage"],
        hiddenNavigationTabs: ["pullRequests", "issues", "usage"],
      }),
    ).toEqual({
      navigationTabOrder: ["companions", "threads", "usage", "pullRequests", "issues"],
      hiddenNavigationTabs: ["pullRequests", "issues"],
    });
  });

  it("counts only tabs the bar shows, and pull requests and issues as one place", () => {
    expect(
      placeUsageTab({
        navigationTabOrder: ["pullRequests", "issues", "companions", "usage", "threads"],
        hiddenNavigationTabs: ["usage"],
      }).navigationTabOrder,
    ).toEqual(["pullRequests", "issues", "companions", "usage", "threads"]);
    expect(
      placeUsageTab({
        navigationTabOrder: ["threads", "pullRequests", "companions", "issues", "usage"],
        hiddenNavigationTabs: ["pullRequests", "issues", "usage"],
      }).navigationTabOrder,
    ).toEqual(["threads", "pullRequests", "companions", "usage", "issues"]);
  });

  it("leaves the defaults alone when nothing was saved", () => {
    expect(placeUsageTab({})).toEqual({});
    expect(placeUsageTab({ hiddenNavigationTabs: ["usage", "issues"] })).toEqual({
      hiddenNavigationTabs: ["issues"],
    });
  });
});
