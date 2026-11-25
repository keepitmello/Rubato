import { describe, expect, it } from "vite-plus/test";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { agyLoginGroups } from "./rubatoAgyLoginGroups";

const agent = (value: string) => ({ name: "RUBATO_LOCAL_AGY_AGENT", value, sensitive: false });
const isolated = { name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1", sensitive: false };
const login = (owner: string) => ({ name: "RUBATO_LOCAL_AGY_LOGIN", value: owner, sensitive: false });
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
  rubato: { driver: "rubato-pi", displayName: "Rubato" },
} as never;
const group = (providerKey: string, providerLabel: string): ProviderGroup => ({
  providerKey,
  providerLabel,
  models: [{ key: `${providerKey}:gemini-4-neon` } as ModelOption],
});
// The order the sheet lists them in, by display name.
const groups = [
  group("agy-rubato-lead", "Antigravity"),
  group("agy-rubato-lead-sub", "Antigravity [sub]"),
  group("agy-rubato-lead-sub-helena", "헬레나"),
  group("agy-helena", "헬레나"),
  group("rubato", "Rubato"),
];
const view = (result: ReturnType<typeof agyLoginGroups>) =>
  result.groups.map((entry) => [entry.providerKey, entry.providerLabel, entry.models[0]!.key]);

describe("agyLoginGroups", () => {
  it("lists the main and sub logins once each, with Rubato and 헬레나 a choice on each", () => {
    const result = agyLoginGroups({
      groups,
      instances,
      picked: new Map(),
      displayedInstanceId: "rubato",
      narrowed: false,
    });
    expect(view(result)).toEqual([
      ["agy-rubato-lead", "Antigravity", "agy-rubato-lead:gemini-4-neon"],
      ["agy-rubato-lead-sub", "Antigravity [sub]", "agy-rubato-lead-sub:gemini-4-neon"],
      ["rubato", "Rubato", "rubato:gemini-4-neon"],
    ]);
    expect(result.choices.get("agy-rubato-lead-sub")).toEqual({
      agents: [
        { instanceId: "agy-rubato-lead-sub", label: "Rubato" },
        { instanceId: "agy-rubato-lead-sub-helena", label: "헬레나" },
      ],
      chosen: "agy-rubato-lead-sub",
    });
  });

  it("opens a login on the agent the thread runs, and shows the agent picked here instead", () => {
    const base = { groups, instances, narrowed: false } as const;
    const onThread = agyLoginGroups({ ...base, picked: new Map(), displayedInstanceId: "agy-rubato-lead-sub-helena" });
    expect(view(onThread)[1]).toEqual([
      "agy-rubato-lead-sub",
      "Antigravity [sub]",
      "agy-rubato-lead-sub-helena:gemini-4-neon",
    ]);
    const picked = agyLoginGroups({
      ...base,
      picked: new Map([["agy-rubato-lead", "agy-helena"]]),
      displayedInstanceId: "agy-rubato-lead-sub-helena",
    });
    expect(view(picked)[0]).toEqual(["agy-rubato-lead", "Antigravity", "agy-helena:gemini-4-neon"]);
    expect(picked.choices.get("agy-rubato-lead")?.chosen).toBe("agy-helena");
  });

  it("lists every agent under its login's name while searching", () => {
    const result = agyLoginGroups({ groups, instances, picked: new Map(), displayedInstanceId: undefined, narrowed: true });
    expect(result.groups.map((entry) => entry.providerLabel)).toEqual([
      "Antigravity · Rubato",
      "Antigravity [sub] · Rubato",
      "Antigravity [sub] · 헬레나",
      "Antigravity · 헬레나",
      "Rubato",
    ]);
    expect(result.choices.size).toBe(0);
  });
});
