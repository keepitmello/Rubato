import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentPanelModel, type RubatoSubagent } from "../rubatoAgentPanelModel";
import {
  AGENT_ROW_LIMIT,
  RubatoThreadDetailsAgents,
  overflowLabel,
  shortModelLabel,
  summarizeThreadDetailsAgents,
} from "./RubatoThreadDetailsAgents";

const AT = "2026-10-18T03:00:00.000Z";

function agent(overrides: Partial<RubatoSubagent> & Pick<RubatoSubagent, "id">): RubatoSubagent {
  return {
    kind: "subagent",
    title: overrides.id,
    label: `Task ${overrides.id}`,
    modelLabel: "Opus 5.5 · High",
    memberName: null,
    board: null,
    awaiting: [],
    assignment: null,
    role: null,
    model: "anthropic/claude-opus-5-5",
    effort: "high",
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
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
    childThreadId: null,
    recentActivity: [],
    firstSeenAt: AT,
    startedAt: AT,
    completedAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

const team = (id: string, status: RubatoSubagent["status"], name = `Team ${id}`) =>
  agent({ id, kind: "workflow", workflowName: name, status });
const member = (
  id: string,
  teamId: string,
  status: RubatoSubagent["status"],
  role: string | null = "owner",
) => agent({ id, parentAgentId: teamId, status, memberName: id, role });

/** What a person reads, without the attributes that name a state for tests and styling. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, "");

function render(agents: RubatoSubagent[]): string {
  return renderToStaticMarkup(
    <RubatoThreadDetailsAgents
      model={deriveAgentPanelModel({ agents })}
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      separated
    />,
  );
}

describe("summarizeThreadDetailsAgents", () => {
  it("keeps team members out of the agent rows", () => {
    const summary = summarizeThreadDetailsAgents(
      deriveAgentPanelModel({
        agents: [
          team("t1", "running", "v13.4 revision"),
          member("m1", "t1", "running"),
          member("m2", "t1", "idle", "verifier"),
          member("m3", "t1", "completed"),
          agent({ id: "solo" }),
        ],
      }),
    );
    expect(summary.teams).toEqual([
      {
        id: "t1",
        name: "v13.4 revision",
        members: [
          { id: "m1", name: "m1", role: "owner", state: "working", job: null },
          { id: "m3", name: "m3", role: "owner", state: "completed", job: null },
          { id: "m2", name: "m2", role: "verifier", state: "waiting", job: null },
        ],
      },
    ]);
    expect(summary.agents.map((row) => row.id)).toEqual(["solo"]);
  });

  it("draws a member without a role as an owner", () => {
    const summary = summarizeThreadDetailsAgents(
      deriveAgentPanelModel({
        agents: [team("t1", "running"), member("m1", "t1", "running", null)],
      }),
    );
    expect(summary.teams[0]?.members[0]?.role).toBe("owner");
  });

  it("counts ended teams and agents instead of listing them", () => {
    const summary = summarizeThreadDetailsAgents(
      deriveAgentPanelModel({
        agents: [
          team("done-team", "completed"),
          agent({ id: "a1", status: "completed" }),
          agent({ id: "a2", status: "idle" }),
        ],
      }),
    );
    expect(summary.teams).toEqual([]);
    expect(summary.finishedTeamCount).toBe(1);
    expect(summary.agents).toEqual([]);
    expect(summary.finishedAgentCount).toBe(2);
  });

  it(`shows at most ${AGENT_ROW_LIMIT} working agents and counts the rest`, () => {
    const agents = Array.from({ length: AGENT_ROW_LIMIT + 2 }, (_, index) =>
      agent({ id: `a${index}`, firstSeenAt: `2026-10-18T03:00:0${index}.000Z` }),
    );
    const summary = summarizeThreadDetailsAgents(deriveAgentPanelModel({ agents }));
    expect(summary.agents).toHaveLength(AGENT_ROW_LIMIT);
    expect(summary.moreAgentCount).toBe(2);
  });
});

describe("labels", () => {
  it("keeps the model name and drops the effort", () => {
    expect(shortModelLabel(agent({ id: "a" }))).toBe("Opus 5.5");
  });

  it("joins only nonzero overflow parts", () => {
    expect(overflowLabel(2, 3)).toBe("+2 more · 3 finished");
    expect(overflowLabel(0, 1)).toBe("1 finished");
    expect(overflowLabel(0, 0)).toBeNull();
  });
});

describe("RubatoThreadDetailsAgents", () => {
  it("draws nothing while nothing runs", () => {
    expect(render([])).toBe("");
    expect(render([agent({ id: "a", status: "completed" }), team("t", "completed")])).toBe("");
  });

  it("draws Team and Agents as separate sections", () => {
    const html = render([
      team("t1", "running", "v13.4 revision"),
      member("m1", "t1", "running"),
      agent({ id: "solo", label: "Fix workspace label" }),
    ]);
    const teamAt = html.indexOf('id="thread-details-team-heading"');
    const agentsAt = html.indexOf('id="thread-details-agents-heading"');
    expect(teamAt).toBeGreaterThan(-1);
    expect(agentsAt).toBeGreaterThan(teamAt);
    expect(html.slice(teamAt, agentsAt)).toContain("v13.4 revision");
    expect(textOf(html.slice(teamAt, agentsAt))).not.toMatch(/working|idle|done/);
    expect(html.slice(agentsAt)).toContain("Fix workspace label");
    expect(html.slice(agentsAt)).toContain("1 working");
    expect(html.slice(agentsAt)).not.toContain("Task m1");
  });

  it("draws only the Team section when no agent works outside a team", () => {
    const html = render([team("t1", "running"), member("m1", "t1", "running")]);
    expect(html).toContain('id="thread-details-team-heading"');
    expect(html).not.toContain('id="thread-details-agents-heading"');
  });

  it("tells owners from verifiers by shape and working from idle by fill", () => {
    const html = render([
      team("t1", "running"),
      member("verify", "t1", "idle", "verifier"),
      member("backend", "t1", "running"),
      member("schema", "t1", "idle"),
    ]);
    const attr = (tag: string, name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
    const glyphs = [...html.matchAll(/<span[^>]*data-role="[^"]*"[^>]*>/g)].map(([tag]) => ({
      name: attr(tag, "data-name"),
      role: attr(tag, "data-role"),
      state: attr(tag, "data-state"),
      className: attr(tag, "class"),
    }));
    expect(glyphs.map(({ name, role, state }) => `${name}:${role}:${state}`)).toEqual([
      "backend:owner:working",
      "schema:owner:waiting",
      "verify:verifier:waiting",
    ]);
    const classOf = (name: string) => glyphs.find((glyph) => glyph.name === name)?.className ?? "";
    expect(classOf("backend")).toContain("rounded-full");
    expect(classOf("verify")).toContain("rotate-45");
    expect(classOf("backend")).toContain("bg-info");
    expect(classOf("schema")).toContain("bg-transparent");
    expect(html).not.toMatch(/\d (working|idle|failed)/);
  });

  it("puts a divider between owners and verifiers only when both are there", () => {
    const divider = 'class="mx-0.5 h-2.5 w-px bg-border"';
    expect(
      render([
        team("t1", "running"),
        member("a", "t1", "running"),
        member("v", "t1", "idle", "verifier"),
      ]),
    ).toContain(divider);
    expect(render([team("t1", "running"), member("a", "t1", "running")])).not.toContain(divider);
    expect(render([team("t1", "running"), member("v", "t1", "running", "verifier")])).not.toContain(
      divider,
    );
  });
});
