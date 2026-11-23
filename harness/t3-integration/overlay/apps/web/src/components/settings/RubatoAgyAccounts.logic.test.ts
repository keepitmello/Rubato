import { describe, expect, it } from "@effect/vitest";

import { agyAccounts, agyAccountsSummary, type AgyLiveInput } from "./RubatoAgyAccounts.logic";

const agent = (value: string) => ({ name: "RUBATO_LOCAL_AGY_AGENT", value });
const isolated = { name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1" };
const ready = (models: string[] = ["Gemini 4 Neon"]): AgyLiveInput => ({
  status: "ready",
  models: models.map((name) => ({ name })),
});

describe("agyAccounts", () => {
  it("counts the lead and Helena on the agy CLI login as one account with two system prompts", () => {
    const accounts = agyAccounts(
      [
        ["agy-rubato-lead", { displayName: "Antigravity", environment: [agent("rubato-lead")] }],
        ["agy-helena", { displayName: "헬레나", environment: [agent("헬레나")] }],
      ],
      new Map([["agy-rubato-lead", ready()], ["agy-helena", ready()]]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ key: "agy-cli", isolated: false, state: "connected", models: ["Gemini 4 Neon"] });
    expect(accounts[0]!.prompts.map((prompt) => [prompt.name, prompt.agent])).toEqual([
      ["Antigravity", "rubato-lead"],
      ["헬레나", "헬레나"],
    ]);
    expect(agyAccountsSummary(accounts)).toEqual({ connected: 1, total: 1, off: false });
  });

  it("gives each separately signed-in Google profile its own account", () => {
    const accounts = agyAccounts(
      [
        ["agy-rubato-lead", { displayName: "Antigravity", environment: [agent("rubato-lead")] }],
        ["agy-rubato-lead-sub", { displayName: "Antigravity [sub]", environment: [agent("rubato-lead"), isolated] }],
        ["antigravity", { displayName: "Plain T3" }],
      ],
      new Map([["agy-rubato-lead", ready()], ["agy-rubato-lead-sub", { status: "error", models: [] }]]),
    );
    expect(accounts.map((account) => [account.key, account.name, account.state])).toEqual([
      ["agy-cli", null, "connected"],
      ["agy-rubato-lead-sub", "Antigravity [sub]", "signin"],
      ["antigravity", "Plain T3", "signin"],
    ]);
    expect(agyAccountsSummary(accounts)).toEqual({ connected: 1, total: 3, off: false });
  });

  it("turns the CLI login off only when every system prompt on it is off", () => {
    const entries = [
      ["agy-rubato-lead", { environment: [agent("rubato-lead")], enabled: false }],
      ["agy-helena", { environment: [agent("헬레나")] }],
    ] as const;
    expect(agyAccounts(entries, new Map())[0]!.state).toBe("checking");
    expect(agyAccounts(entries, new Map([["agy-helena", { status: "error", models: [] }]]))[0]!.state).toBe("absent");
    const off = agyAccounts([[entries[0][0], entries[0][1]]], new Map());
    expect(off[0]!.state).toBe("off");
    expect(agyAccountsSummary(off)).toEqual({ connected: 0, total: 1, off: true });
  });
});
