import { describe, expect, it } from "vite-plus/test";

import { agyPickerAccounts } from "./rubatoAgyPicker";

const agent = (value: string) => ({ name: "RUBATO_LOCAL_AGY_AGENT", value });
const isolated = { name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1" };
const login = (owner: string) => ({ name: "RUBATO_LOCAL_AGY_LOGIN", value: owner });

const instances = {
  "agy-rubato-lead": { driver: "antigravity", displayName: "Antigravity", environment: [agent("rubato-lead")] },
  "agy-helena": { driver: "antigravity", displayName: "헬레나", environment: [agent("헬레나")] },
  "agy-rubato-lead-sub": {
    driver: "antigravity",
    displayName: "Antigravity [sub]",
    environment: [agent("rubato-lead"), isolated],
  },
  "agy-rubato-lead-sub-helena": {
    driver: "antigravity",
    displayName: "헬레나",
    environment: [agent("헬레나"), isolated, login("agy-rubato-lead-sub")],
  },
  rubato: { driver: "rubato-pi" },
};

describe("agyPickerAccounts", () => {
  it("shows each login once, with its lead first among the agents on it", () => {
    const accounts = agyPickerAccounts(instances, [
      "rubato",
      "agy-helena",
      "agy-rubato-lead",
      "agy-rubato-lead-sub-helena",
      "agy-rubato-lead-sub",
    ]);
    expect(accounts).toEqual([
      {
        railId: "agy-rubato-lead",
        label: "Antigravity",
        agents: [
          { instanceId: "agy-rubato-lead", label: "Rubato" },
          { instanceId: "agy-helena", label: "헬레나" },
        ],
      },
      {
        railId: "agy-rubato-lead-sub",
        label: "Antigravity [sub]",
        agents: [
          { instanceId: "agy-rubato-lead-sub", label: "Rubato" },
          { instanceId: "agy-rubato-lead-sub-helena", label: "헬레나" },
        ],
      },
    ]);
  });

  it("leaves out instances the picker does not show", () => {
    expect(agyPickerAccounts(instances, ["agy-helena"])).toEqual([
      { railId: "agy-helena", label: "Antigravity", agents: [{ instanceId: "agy-helena", label: "헬레나" }] },
    ]);
    expect(agyPickerAccounts(undefined, ["agy-helena"])).toEqual([]);
  });
});
