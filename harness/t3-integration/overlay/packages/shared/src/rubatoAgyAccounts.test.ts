import { describe, expect, it } from "vite-plus/test";

import { agyAccounts, agyAccountsSummary, agySignInView, type AgyLiveInput } from "./rubatoAgyAccounts.ts";

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

  it("puts another agent on an isolated login under that login's account", () => {
    const login = { name: "RUBATO_LOCAL_AGY_LOGIN", value: "agy-rubato-lead-sub" };
    const accounts = agyAccounts(
      [
        ["agy-helena-sub", { displayName: "헬레나", environment: [agent("헬레나"), isolated, login] }],
        ["agy-rubato-lead-sub", { displayName: "Antigravity [sub]", environment: [agent("rubato-lead"), isolated] }],
      ],
      new Map([["agy-rubato-lead-sub", ready()]]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ key: "agy-rubato-lead-sub", name: "Antigravity [sub]", state: "connected" });
    expect(accounts[0]!.prompts.map((prompt) => [prompt.instanceId, prompt.agent])).toEqual([
      ["agy-rubato-lead-sub", "rubato-lead"],
      ["agy-helena-sub", "헬레나"],
    ]);
  });

  it("asks to sign in again when any agent on a shared login found it signed out, though its holder did not", () => {
    const login = { name: "RUBATO_LOCAL_AGY_LOGIN", value: "agy-rubato-lead-sub" };
    const entries = [
      ["agy-rubato-lead-sub", { displayName: "Antigravity [sub]", environment: [agent("rubato-lead"), isolated] }],
      ["agy-helena-sub", { displayName: "헬레나", environment: [agent("헬레나"), isolated, login] }],
    ] as const;
    const holder = { status: "ready", auth: { status: "authenticated" }, models: [{ name: "Gemini 4 Neon" }] };
    const signedOut = { status: "warning", auth: { status: "unauthenticated" }, models: [] };

    const [account] = agyAccounts(entries, new Map([["agy-rubato-lead-sub", holder], ["agy-helena-sub", signedOut]]));
    expect(account!.state).toBe("signin");
    // The holder's own "signed in" must not hide the sign-in button for the login.
    expect(agySignInView(account!, holder).auth.status).toBe("unauthenticated");

    const [healthy] = agyAccounts(entries, new Map([["agy-rubato-lead-sub", holder], ["agy-helena-sub", holder]]));
    expect(healthy!.state).toBe("connected");
    expect(agySignInView(healthy!, holder)).toBe(holder);
  });

  it("ignores a turned-off agent's sign-in state on a shared login", () => {
    const login = { name: "RUBATO_LOCAL_AGY_LOGIN", value: "agy-rubato-lead-sub" };
    const [account] = agyAccounts(
      [
        ["agy-rubato-lead-sub", { environment: [agent("rubato-lead"), isolated] }],
        ["agy-helena-sub", { environment: [agent("헬레나"), isolated, login], enabled: false }],
      ],
      new Map([
        ["agy-rubato-lead-sub", ready()],
        ["agy-helena-sub", { status: "warning", auth: { status: "unauthenticated" }, models: [] }],
      ]),
    );
    expect(account!.state).toBe("connected");
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
