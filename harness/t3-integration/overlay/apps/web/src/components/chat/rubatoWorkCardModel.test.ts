import { describe, expect, it } from "vite-plus/test";

import {
  isRubatoLaunchItem,
  launchResultOf,
  rubatoLaunchOfItem,
  workCardModelLabel,
  workCardState,
  workCardUpdatedAt,
} from "./rubatoWorkCardModel";

const AT = "2026-11-09T04:00:00.000Z";
const created = `Created "원화 출금 설계" (S2) in /w; it is running. It runs on anthropic/claude-opus-5-5-sub.\n${JSON.stringify(
  { sessionId: "S2", title: "원화 출금 설계", cwd: "/w", status: "running", model: "anthropic/claude-opus-5-5-sub" },
  null,
  2,
)}`;
const item = (toolName: string, status: string, input: unknown, output?: unknown) =>
  ({ type: "dynamic_tool", toolName, status, input, ...(output === undefined ? {} : { output }) }) as never;
const shell = (fields: Record<string, unknown> = {}) =>
  ({
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    visibleItemCount: 1,
    ...fields,
  }) as never;
const run = (status: string) => ({ runId: "r", status, requestedAt: AT, startedAt: AT, completedAt: null, assistantMessageId: null });

describe("work cards for launched conversations", () => {
  it("knows session_create and session_fork by name and nothing else", () => {
    expect(isRubatoLaunchItem({ type: "dynamic_tool", toolName: "session_create" })).toBe(true);
    expect(isRubatoLaunchItem({ type: "dynamic_tool", toolName: "session_fork" })).toBe(true);
    expect(isRubatoLaunchItem({ type: "dynamic_tool", toolName: "Agent" })).toBe(false);
    expect(isRubatoLaunchItem({ type: "dynamic_tool", toolName: "session_send" })).toBe(false);
    expect(rubatoLaunchOfItem(item("task", "completed", {}))).toBeNull();
  });

  it("reads the launched conversation from the result, as text or content blocks", () => {
    expect(rubatoLaunchOfItem(item("session_create", "completed", { title: "x", text: "go" }, created))).toEqual({
      tool: "create",
      sessionId: "S2",
      title: "원화 출금 설계",
      model: "anthropic/claude-opus-5-5-sub",
      startsWork: true,
      error: null,
      pending: false,
    });
    const fork = rubatoLaunchOfItem(
      item("session_fork", "completed", {}, { content: [{ type: "text", text: 'Forked into "A (fork)" (S3) with 4 messages.' }] }),
    )!;
    expect(fork).toMatchObject({ tool: "fork", sessionId: "S3", title: "A (fork)", startsWork: false });
    expect(launchResultOf('Created "x" (S9) in /w.\n{"sessionId": "S9", "ti')?.sessionId).toBe("S9");
  });

  it("says starting while the call runs, and failed with the reason when it did not start", () => {
    const pending = rubatoLaunchOfItem(item("session_create", "inProgress", { title: "설계", model: "openai-codex/gpt-6.1-sol", text: "go" }))!;
    expect(pending).toMatchObject({ sessionId: null, title: "설계", model: "openai-codex/gpt-6.1-sol", pending: true, error: null });
    expect(workCardState(pending, null)).toBe("starting");
    const failed = rubatoLaunchOfItem(item("session_create", "failed", { text: "go" }, "Could not create a conversation in /nope"))!;
    expect(failed.error).toBe("Could not create a conversation in /nope");
    expect(workCardState(failed, shell())).toBe("failed");
  });

  it("never claims an outcome for a result that names no conversation", () => {
    const odd = rubatoLaunchOfItem(item("session_create", "completed", { text: "go" }, "ok"))!;
    expect(odd.sessionId).toBeNull();
    expect(workCardState(odd, null)).toBe("failed");
  });

  it("follows the launched thread: starting, working, waiting for the person, done, failed, stopped", () => {
    const launch = { error: null, pending: false, startsWork: true };
    expect(workCardState(launch, null)).toBe("starting");
    expect(workCardState(launch, shell())).toBe("starting");
    expect(workCardState(launch, shell({ runtime: { status: "running" }, latestRun: run("running") }))).toBe("working");
    expect(workCardState(launch, shell({ runtime: { status: "running" }, hasPendingUserInput: true }))).toBe("waiting");
    expect(workCardState(launch, shell({ hasPendingApprovals: true }))).toBe("waiting");
    expect(workCardState(launch, shell({ runtime: { status: "idle" }, latestRun: run("completed") }))).toBe("done");
    expect(workCardState(launch, shell({ runtime: { status: "failed" }, latestRun: run("failed") }))).toBe("failed");
    expect(workCardState(launch, shell({ runtime: { status: "idle" }, latestRun: run("interrupted") }))).toBe("stopped");
    expect(workCardState(launch, shell({ latestRun: run("cancelled") }))).toBe("stopped");
    expect(workCardState(launch, shell({ visibleItemCount: 3 })), "imported after it already answered").toBe("done");
    expect(workCardState({ ...launch, startsWork: false }, shell()), "a fork with no message waits for the person").toBe("waiting");
  });

  it("shows the model without its vendor and the latest time the thread moved", () => {
    expect(workCardModelLabel("anthropic/claude-opus-5-5-sub")).toBe("opus-5-5-sub");
    expect(workCardModelLabel("openai-codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(workCardModelLabel(null)).toBeNull();
    expect(
      workCardUpdatedAt({
        latestRun: { ...run("completed"), completedAt: "2026-11-09T04:05:00.000Z" },
        runtime: null,
        updatedAt: "2026-11-09T04:01:00.000Z",
      } as never),
    ).toBe("2026-11-09T04:05:00.000Z");
    expect(workCardUpdatedAt(null)).toBeNull();
  });
});
