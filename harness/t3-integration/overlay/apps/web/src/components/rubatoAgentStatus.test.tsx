// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The thread's timeline pulls in the diff worker, which a node test cannot load.
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));

import { createPageTranslation, createUiTranslator, type UiDictionary } from "../rubatoI18n";
import korean from "../rubatoI18n.ko.json";
import type { RubatoSessionState } from "../state/rubatoSessionState";
import { RubatoThreadDetailsAgents } from "./chat/RubatoThreadDetailsAgents";
import { RubatoAgentsPanel, agentStateLine, assignmentLabel } from "./RubatoAgentsPanel";
import {
  deriveAgentPanelModel,
  rubatoAgentsFromSessionState,
  type RubatoSubagent,
} from "./rubatoAgentPanelModel";
import { AGENT_STATE_VISUALS, AgentElapsed, agentDisplayState } from "./rubatoAgentStatus";

const TEAM_START = "2026-10-19T13:19:25.000Z";
/** The last time the team row changed: when its members all came to rest. */
const TEAM_RESTED = "2026-10-19T17:24:25.000Z";
const NOW = "2026-10-19T19:19:25.000Z";

/** The live team behind the report: four members, each in a different state. */
const STATE: RubatoSessionState = {
  speedIndex: null,
  cache: null,
  teams: [
    {
      teamRunId: "call_team",
      name: "segno-resident",
      status: "idle",
      startedAt: TEAM_START,
      updatedAt: TEAM_RESTED,
      members: ["st_engine", "st_hub", "st_messenger", "st_verifier"],
      board: { tasks: [] },
    },
  ],
  agents: [
    {
      taskId: "st_engine",
      title: "engine",
      label: "Engine as launchd service, scheduler inside",
      memberName: "engine",
      role: "owner",
      teamRunId: "call_team",
      status: "running",
      activity: "bash npm test",
      assignment: { from: "lead", summary: "Segno sleep at dawn" },
      startedAt: TEAM_START,
      updatedAt: NOW,
    },
    {
      taskId: "st_hub",
      title: "hub",
      label: "Remote hub as an engine-supervised child",
      memberName: "hub",
      role: "owner",
      teamRunId: "call_team",
      status: "idle",
      awaiting: [{ id: "bash_178", description: "node --test harness/pi-runtime (sandbox)" }],
      activity: "Sandbox suite started; I report when it ends.",
      startedAt: TEAM_START,
      updatedAt: NOW,
    },
    {
      taskId: "st_messenger",
      title: "messenger",
      label: "Telegram for Segno inside the engine",
      memberName: "messenger",
      role: "owner",
      teamRunId: "call_team",
      status: "completed",
      result: "Telegram messenger done.",
      startedAt: TEAM_START,
      updatedAt: NOW,
      completedAt: NOW,
    },
    {
      taskId: "st_verifier",
      title: "verifier",
      label: "Independent sandbox checks of resident engine",
      memberName: "verifier",
      role: "verifier",
      teamRunId: "call_team",
      status: "idle",
      // The server folds the latest final message into activity; result is an older run's answer.
      activity: "Verified up to 0e4924c98.",
      result: "Baseline checks are saved in verifier.md.",
      assignment: { from: "engine" },
      startedAt: TEAM_START,
      updatedAt: NOW,
    },
  ],
};

const agents = () => rubatoAgentsFromSessionState(STATE);
const byId = (id: string) => agents().find((agent) => agent.id === id) as RubatoSubagent;

function renderPanel(): string {
  return renderToStaticMarkup(<RubatoAgentsPanel model={deriveAgentPanelModel({ agents: agents() })} />);
}

function renderMenu(): string {
  return renderToStaticMarkup(
    <RubatoThreadDetailsAgents
      model={deriveAgentPanelModel({ agents: agents() })}
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      separated
    />,
  );
}

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("agentDisplayState", () => {
  it("tells a member with its own job from one only a message wakes, and both from working", () => {
    const resting = { status: "idle" as const, awaiting: [] };
    const onJob = { status: "idle" as const, awaiting: [{ id: "bash_1", description: "npm test" }] };
    expect(agentDisplayState({ status: "running", awaiting: [] }, true)).toBe("working");
    expect(agentDisplayState({ status: "pending", awaiting: [] }, true)).toBe("working");
    expect(agentDisplayState(onJob, true)).toBe("background");
    expect(agentDisplayState(onJob, false)).toBe("background");
    expect(agentDisplayState(resting, true)).toBe("waiting");
    expect(agentDisplayState(resting, false)).toBe("idle");
    expect(agentDisplayState({ status: "completed", awaiting: [] }, true)).toBe("completed");
    expect(agentDisplayState({ status: "cancelled", awaiting: [] }, true)).toBe("stopped");
    expect(new Set(["working", "background", "waiting"].map((state) => AGENT_STATE_VISUALS[state as "working"].glyphClass)).size).toBe(3);
  });
});

describe("one state mapping for the panel and the floating menu", () => {
  it("each member's panel row and its glyph name the same state and draw it from the same table", () => {
    const panel = renderPanel();
    const menu = renderMenu();
    const rows = new Map(
      [...panel.matchAll(/<button[^>]*aria-label="([^"]*): open conversation[^"]*"[^>]*data-state="([^"]*)"/g)].map(
        ([, task, state]) => [task, state],
      ),
    );
    const glyphs = [...menu.matchAll(/<span[^>]*data-role="[^"]*"[^>]*>/g)].map(([tag]) => ({
      name: attr(tag, "data-name"),
      state: attr(tag, "data-state"),
      className: attr(tag, "class"),
    }));
    const expected = { engine: "working", hub: "background", messenger: "completed", verifier: "waiting" };
    expect(Object.fromEntries(glyphs.map((glyph) => [glyph.name, glyph.state]))).toEqual(expected);
    for (const agent of agents().filter((item) => item.kind !== "workflow")) {
      const state = expected[agent.memberName as keyof typeof expected];
      expect(rows.get(agent.label ?? "")).toBe(state);
      expect(glyphs.find((glyph) => glyph.name === agent.memberName)?.className).toContain(
        AGENT_STATE_VISUALS[state as keyof typeof AGENT_STATE_VISUALS].glyphClass,
      );
    }
  });
});

describe("a member's lines", () => {
  it("a resting member's summary follows its latest final message, not an earlier run's result", () => {
    expect(agentStateLine(byId("st_verifier"), true)).toBe("Waiting for instructions · Verified up to 0e4924c98.");
    expect(renderPanel()).not.toContain("Baseline checks are saved");
  });

  it("a member on its own job names the job; the title stays its first task", () => {
    expect(agentStateLine(byId("st_hub"), true)).toBe("Background job · node --test harness/pi-runtime (sandbox)");
    expect(renderPanel()).toContain("Remote hub as an engine-supervised child");
  });

  it("the latest assignment shows its summary, or says the sender gave none", () => {
    expect(assignmentLabel(byId("st_engine"))).toBe("Assigned by Lead: Segno sleep at dawn");
    expect(assignmentLabel(byId("st_verifier"))).toBe("Assigned by engine · no summary given");
    expect(assignmentLabel(byId("st_hub"))).toBeNull();
  });
});

describe("team elapsed", () => {
  it("counts from the team's start to now while its members rest, not to its last change", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const team = agents().find((agent) => agent.kind === "workflow") as RubatoSubagent;
    expect(team.status).toBe("idle");
    expect(renderToStaticMarkup(<AgentElapsed agent={team} />)).toContain("6h 00m");
    const ended = { ...team, status: "completed" as const, completedAt: TEAM_RESTED };
    expect(renderToStaticMarkup(<AgentElapsed agent={ended} />)).toContain("4h 05m");
  });
});

describe("in the Korean interface", () => {
  it("the states, counts and the floating menu's finished count all read in Korean", () => {
    const container = document.createElement("div");
    const finished: RubatoSessionState = {
      ...STATE,
      agents: [
        ...STATE.agents,
        { taskId: "st_done", title: "done", label: "Old scout", status: "completed", startedAt: TEAM_START, updatedAt: NOW },
        { taskId: "st_solo", title: "solo", label: "Fix the sidebar", status: "running", startedAt: TEAM_START, updatedAt: NOW },
      ],
    };
    const model = deriveAgentPanelModel({ agents: rubatoAgentsFromSessionState(finished) });
    container.innerHTML =
      renderToStaticMarkup(<RubatoAgentsPanel model={model} />) +
      renderToStaticMarkup(
        <RubatoThreadDetailsAgents
          model={model}
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          separated
        />,
      );
    document.body.append(container);
    const page = createPageTranslation(container, createUiTranslator(korean as unknown as UiDictionary));
    page.start();
    const text = container.textContent ?? "";
    page.stop();
    for (const phrase of [
      "지시 대기 중 · Verified up to 0e4924c98.",
      "백그라운드 작업 중 · node --test harness/pi-runtime (sandbox)",
      "1개 작업 중",
      "1개 백그라운드",
      "1개 대기",
      "1개 완료",
      "1개 완료됨",
      "리드의 지시: Segno sleep at dawn",
      "engine의 지시 · 요약 없음",
    ]) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toMatch(/\d (finished|waiting|on a job|done)\b/);
  });
});
