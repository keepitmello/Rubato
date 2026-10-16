import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RubatoSessionState } from "../../state/rubatoSessionState";

// The panel module pulls in the thread's timeline, which a node test cannot load.
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));

import { RubatoSpawnRow, rubatoSpawnFor, spawnCallId } from "./RubatoSpawnRow";

const AT = "2026-10-16T10:00:00.000Z";
const state: RubatoSessionState = {
  cache: null,
  speedIndex: null,
  agents: [
    {
      taskId: "st_a",
      spawnToolCallId: "call-agent",
      title: "opus-5-5 · high · Review…",
      label: "Review the port",
      modelLabel: "Opus 5.5 · High",
      role: "verifier",
      status: "running",
      activity: "Reading apply.mjs",
      speedIndex: 140,
      turns: 3,
      startedAt: AT,
      updatedAt: AT,
    },
    { taskId: "st_m", title: "ui", memberName: "ui", status: "idle", startedAt: AT, updatedAt: AT },
  ],
  teams: [{ teamRunId: "team-1", spawnToolCallId: "call-team", name: "t3-v2-port", members: ["st_m"], board: null }],
};

const tool = (toolName: string, nativeId: string) =>
  ({ type: "dynamic_tool", toolName, nativeItemRef: { driver: "rubato-pi", nativeId, strength: "strong" } }) as never;

describe("Rubato spawn rows in the conversation", () => {
  it("recognizes the spawn tools by name and keys them by the Pi call id", () => {
    expect(spawnCallId(tool("Agent", "call-agent"))).toBe("call-agent");
    expect(spawnCallId(tool("team_create", "call-team"))).toBe("call-team");
    expect(spawnCallId(tool("read", "call-read"))).toBeNull();
  });

  it("draws an Agent call as its agent, in the panel's row grammar", () => {
    const spawn = rubatoSpawnFor(state, "call-agent")!;
    const html = renderToStaticMarkup(<RubatoSpawnRow spawn={spawn} />);
    expect(html).toContain("Review the port");
    expect(html).toContain("Reading apply.mjs");
    expect(html).toContain("Verifier · Opus 5.5 · High · Speed 140 · turn 3");
    expect(html).toContain("Working");
  });

  it("draws team_create as its taskforce with member counts", () => {
    const html = renderToStaticMarkup(<RubatoSpawnRow spawn={rubatoSpawnFor(state, "call-team")!} />);
    expect(html).toContain("Taskforce · t3-v2-port");
    expect(html).toContain("1 waiting");
  });

  it("leaves a call the roster does not know to the plain tool row", () => {
    expect(rubatoSpawnFor(state, "call-unknown")).toBeNull();
  });
});
