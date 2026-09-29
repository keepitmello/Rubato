import {
  deriveAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  QUIET_AFTER_MS,
  RubatoAgentsPanel,
  agentMetaParts,
  boardTaskStateLabel,
  quietLabel,
  splitAgentsByActivity,
} from "./RubatoAgentsPanel";

const AT = "2026-09-27T03:00:00.000Z";

function agent(overrides: Partial<RuntimeSubagent> & Pick<RuntimeSubagent, "id">): RuntimeSubagent {
  return {
    kind: "subagent",
    title: "opus-5-5 · high · Isolated T3 sandbox for the…",
    label: "Isolated T3 sandbox for the Agents panel redesign",
    modelLabel: "Opus 5.5 · High",
    memberName: null,
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

  it("a resting team member reads Waiting with what it last said, and the members come before the board", () => {
    const html = render([
      agent({
        id: "call_team",
        kind: "workflow",
        workflowName: "scheduled-tasks",
        label: "scheduled-tasks",
        board: {
          tasks: [
            { id: "1", subject: "Scheduler core", description: "Owner: backend. intent_ref {sha256:f993}",
              descriptionTruncated: false, status: "claimed", owner: "backend", blockedBy: [], updatedAt: AT },
            { id: "3", subject: "Independent verdict", description: "", descriptionTruncated: false,
              status: "pending", owner: null, blockedBy: ["1"], updatedAt: AT },
          ],
        },
      }),
      agent({ id: "st_backend", kind: "workflow_agent", parentAgentId: "call_team", role: "owner" }),
      agent({ id: "st_gui", kind: "workflow_agent", parentAgentId: "call_team", role: "owner", status: "idle",
        memberName: "gui", progress: "Waiting on the build." }),
    ]);
    expect(html).toMatch(/>gui<\/span>Isolated T3 sandbox/);
    expect(html).toContain("1 working · 1 waiting");
    expect(html).toContain("Waiting · Waiting on the build.");
    expect(html.indexOf("Waiting on the build.")).toBeLessThan(html.indexOf(">Board<"));
    // The brief is the lead's instruction to the agent: folded until asked for.
    expect(html).not.toContain("intent_ref");
  });

  it("a board row names its state at a glance", () => {
    const task = (status: "pending" | "claimed" | "in_progress" | "completed", owner: string | null) => ({
      id: "2", subject: "s", description: "", descriptionTruncated: false, status, owner, blockedBy: ["1"], updatedAt: AT,
    });
    expect(boardTaskStateLabel(task("in_progress", "gui"), [])).toBe("in progress · gui");
    expect(boardTaskStateLabel(task("completed", "lead"), [])).toBe("done · Lead");
    expect(boardTaskStateLabel(task("pending", null), ["1", "4"])).toBe("waits on #1, #4");
    expect(boardTaskStateLabel(task("pending", null), [])).toBe("open");
  });

  it("a live agent reads quiet only after two minutes without an update", () => {
    const start = Date.parse(AT);
    const live = agent({ id: "st_a" });
    expect(quietLabel(live, start + QUIET_AFTER_MS - 1)).toBeNull();
    expect(quietLabel(live, start + 3 * 60_000)).toBe("quiet 3m");
    expect(quietLabel(agent({ id: "st_b", status: "completed" }), start + 10 * 60_000)).toBeNull();
  });

  it("working agents stay open on top; finished and idle ones fold below, newest first", () => {
    const agents = [
      agent({ id: "st_old", status: "completed", completedAt: "2026-09-27T03:05:00.000Z" }),
      agent({ id: "st_live" }),
      agent({ id: "st_idle", status: "idle", updatedAt: "2026-09-27T03:20:00.000Z" }),
      agent({ id: "st_new", status: "failed", completedAt: "2026-09-27T03:10:00.000Z" }),
    ];
    const { live, finished } = splitAgentsByActivity(agents);
    expect(live.map((item) => item.id)).toEqual(["st_live"]);
    expect(finished.map((item) => item.id)).toEqual(["st_idle", "st_new", "st_old"]);
    const html = render(agents);
    expect(html).toContain("In progress");
    expect(html).toContain("1 idle · 1 done · 1 failed");
    expect(html).toContain("Now writing the script and helpers.");
    expect(html.match(/aria-expanded="false"[^>]*>[^]*?Finished/)).not.toBeNull();
    // Folded: only the live row is rendered.
    expect(html.match(/Show report/g)?.length).toBe(1);
  });

  it("a resumed idle agent moves back to In progress", () => {
    const resumed = splitAgentsByActivity([agent({ id: "st_idle", status: "running" })]);
    expect(resumed.live.map((item) => item.id)).toEqual(["st_idle"]);
    expect(resumed.finished).toEqual([]);
  });
});
