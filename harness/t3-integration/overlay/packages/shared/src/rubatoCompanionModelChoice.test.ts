import { expect, it } from "vitest";
import type { ServerSettings } from "@t3tools/contracts";
import {
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
