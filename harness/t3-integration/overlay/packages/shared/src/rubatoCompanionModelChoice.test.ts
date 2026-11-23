import { expect, it } from "vitest";
import type { ServerSettings } from "@t3tools/contracts";
import {
  AGY_CLI_ACCOUNT_LABEL,
  COMPANION_GEMINI_DEFAULT_MODEL,
  companionCreateBody,
  companionGeminiStart,
  companionModelAccounts,
} from "./rubatoCompanionModelChoice.ts";

const instanceId = "agy-account";
const medium = `${COMPANION_GEMINI_DEFAULT_MODEL}-medium`;
const neon = "gemini-4-neon";
const settings = {
  [instanceId]: { environment: [{ name: "RUBATO_LOCAL_AGY_AGENT", value: "rubato-lead" }] },
} as unknown as ServerSettings["providerInstances"];
const provider = {
  instanceId, driver: "antigravity" as const, enabled: true, installed: true,
  status: "ready" as const, availability: "available" as const,
  models: [{ slug: neon, name: "Neon" }, { slug: medium, name: "Hydrogen Medium" }],
} as Parameters<typeof companionModelAccounts>[0][number];

it("prefers Hydrogen Medium without changing the native default or an explicit model pick", () => {
  const accounts = companionModelAccounts([provider], settings);
  expect(companionGeminiStart(accounts)).toEqual({ instanceId, model: medium });
  expect(companionCreateBody(null)).toEqual({});
  expect(companionCreateBody({ instanceId, model: neon })).toEqual({ modelSelection: { instanceId, model: neon } });
});

it("does not opt into a disabled account or fall back to a different model", () => {
  expect(companionModelAccounts([{ ...provider, enabled: false }], settings)).toEqual([]);
  expect(companionModelAccounts([provider], undefined)).toEqual([]);
  const accounts = companionModelAccounts([{ ...provider, models: [provider.models[0]!] }], settings);
  expect(companionGeminiStart(accounts)).toEqual({ instanceId, model: null });
});

it("offers the agy CLI login once however many system prompts run on it, and each separate login on its own", () => {
  const agent = (value: string) => ({ name: "RUBATO_LOCAL_AGY_AGENT", value });
  const instances = {
    "agy-rubato-lead": { displayName: "Antigravity", environment: [agent("rubato-lead")] },
    "agy-helena": { displayName: "헬레나", environment: [agent("헬레나")] },
    "agy-rubato-lead-sub": {
      displayName: "Antigravity [sub]",
      environment: [agent("rubato-lead"), { name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1" }],
    },
  } as unknown as ServerSettings["providerInstances"];
  const accounts = companionModelAccounts(
    [
      { ...provider, instanceId: "agy-helena" as never, displayName: "헬레나" },
      { ...provider, instanceId: "agy-rubato-lead" as never, displayName: "Antigravity" },
      { ...provider, instanceId: "agy-rubato-lead-sub" as never, displayName: "Antigravity [sub]" },
    ],
    instances,
  );
  expect(accounts.map((account) => [account.instanceId, account.label])).toEqual([
    ["agy-helena", AGY_CLI_ACCOUNT_LABEL],
    ["agy-rubato-lead-sub", "Antigravity [sub]"],
  ]);
});
