import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkMenuItems } from "./rubatoThreadFork";

const env = "env-1" as EnvironmentId;
const thread = (instanceId: string) => ({
  environmentId: env,
  modelSelection: { instanceId, model: "anthropic/claude-opus-5-5" } as ModelSelection,
});
const rubatoOnly = (_: EnvironmentId, instanceId: string) => instanceId === "rubato";

describe("the legacy sidebar's Fork thread", () => {
  it("is offered for a thread that runs on Rubato", () => {
    expect(forkMenuItems(thread("rubato"), rubatoOnly)).toEqual([{ id: "fork", label: "Fork thread" }]);
  });

  it("is not offered for another provider's thread", () => {
    expect(forkMenuItems(thread("codex"), rubatoOnly)).toEqual([]);
  });
});
