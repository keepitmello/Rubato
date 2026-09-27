import {
  deriveAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QUIET_AFTER_MS, RubatoAgentsPanel, agentMetaParts, quietLabel } from "./RubatoAgentsPanel";

const AT = "2026-09-27T03:00:00.000Z";

function agent(overrides: Partial<RuntimeSubagent> & Pick<RuntimeSubagent, "id">): RuntimeSubagent {
  return {
    kind: "subagent",
    title: "opus-5-5 · high · Isolated T3 sandbox for the…",
    label: "Isolated T3 sandbox for the Agents panel redesign",
    modelLabel: "Opus 5.5 · High",
    board: null,
    role: null,
    model: "anthropic/claude-opus-5-5",
    effort: "high",
    status: "running",
    activationCount: 1,
    usage: { totalTokens: 1200, toolUses: 52, speedIndex: 176, turns: 14 },
    progress: "Now writing the script and helpers.",
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: AT,
    startedAt: AT,
    completedAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

function render(agents: RuntimeSubagent[]): string {
  return renderToStaticMarkup(<RubatoAgentsPanel model={deriveAgentPanelModel({ agents })} />);
}

describe("RubatoAgentsPanel", () => {
  it("an agent row leads with its task and names the model as the picker does, with turns instead of tools", () => {
    const html = render([agent({ id: "st_a" })]);
    expect(html).toContain("Isolated T3 sandbox for the Agents panel redesign");
    expect(html).not.toContain("opus-5-5 · high ·");
    expect(agentMetaParts(agent({ id: "st_a" }))).toEqual(["Opus 5.5 · High", "Speed 176", "turn 14"]);
    expect(html).not.toMatch(/tools/);
  });

  it("plain agents alone get no section header; next to a taskforce they are headed Agents", () => {
    const alone = render([agent({ id: "st_a" })]);
    expect(alone).not.toMatch(/Direct spawns|>Agents<|>Taskforce</);
    const mixed = render([
      agent({ id: "st_a" }),
      agent({ id: "call_team", kind: "workflow", workflowName: "auth-refactor", label: "auth-refactor" }),
      agent({ id: "st_owner", kind: "workflow_agent", parentAgentId: "call_team", role: "owner" }),
    ]);
    expect(mixed).toContain(">Taskforce<");
    expect(mixed).toContain(">Agents<");
  });

  it("a taskforce card counts its members, shows board progress and prefixes the member role", () => {
    const html = render([
      agent({
        id: "call_team",
        kind: "workflow",
        workflowName: "auth-refactor",
        label: "auth-refactor",
        board: {
          tasks: [
            { id: "1", subject: "Refresh path", description: "Rewrite refresh.", descriptionTruncated: false,
              status: "completed", owner: "owner", blockedBy: [], updatedAt: AT },
            { id: "2", subject: "Verify refresh", description: "", descriptionTruncated: false,
              status: "in_progress", owner: "verifier", blockedBy: ["1"], updatedAt: AT },
          ],
        },
      }),
      agent({ id: "st_owner", kind: "workflow_agent", parentAgentId: "call_team", role: "owner", status: "completed" }),
      agent({ id: "st_verifier", kind: "workflow_agent", parentAgentId: "call_team", role: "verifier" }),
    ]);
    expect(html).toContain("auth-refactor");
    expect(html).toContain("1 working · 1 done");
    expect(html).toContain("1/2 done · 1 in progress");
    expect(html).toContain("Owner · Opus 5.5 · High");
    expect(html).toContain("Verifier · Opus 5.5 · High");
  });

  it("a live agent reads quiet only after two minutes without an update", () => {
    const start = Date.parse(AT);
    const live = agent({ id: "st_a" });
    expect(quietLabel(live, start + QUIET_AFTER_MS - 1)).toBeNull();
    expect(quietLabel(live, start + 3 * 60_000)).toBe("quiet 3m");
    expect(quietLabel(agent({ id: "st_b", status: "completed" }), start + 10 * 60_000)).toBeNull();
  });
});
