// A GUI restart restores a session's agents and teams with the links behind them (session-state.mjs
// saved/restore, events.mjs savedTasks/restoreTasks): the next live tick keeps the team meaning.
import test from "node:test";
import assert from "node:assert/strict";
import { SessionStateFold } from "../src/session-state.mjs";

const names = {
  threadId: "new-v2-team-thread", sessionId: "retained-native-session",
  team: "verifier-restored-team", call: "native-team-spawn-call",
  first: "owner-child", second: "checking-child",
};
const tick = (fold, task) => fold.feed({
  type: "extension_event", name: "rubato.task.updated", data: { tasks: [task] },
});
function runningTeam() {
  const fold = new SessionStateFold(names);
  fold.feed({ type: "agent_start" });
  fold.feed({ type: "tool_execution_end", toolName: "team_create", toolCallId: names.call,
    isError: false, result: { details: { kind: "created", team_name: "Long running team",
      team_run_id: names.team, members: [
        { name: "owner", task_id: names.first, role: "owner", task_summary: "Make it" },
        { name: "verifier", task_id: names.second, role: "verifier", task_summary: "Check it" },
      ] } } });
  return fold;
}
function restored(fold) {
  return SessionStateFold.restore(JSON.parse(JSON.stringify(fold.saved())), names);
}
test("control: a resident team member waits instead of finishing before a GUI restart", () => {
  const fold = runningTeam();
  tick(fold, { task_id: names.first, status: "completed", residency_state: "resident", final_response: "Waiting for feedback." });
  assert.equal(fold.snapshot().agents.find((agent) => agent.taskId === names.first).status, "waiting");
});
test("after a GUI restart, a resident member still waits and keeps the real spawn-row linkage", () => {
  const fold = restored(runningTeam());
  tick(fold, { task_id: names.first, status: "completed", residency_state: "resident", final_response: "Waiting for feedback." });
  const member = fold.snapshot().agents.find((agent) => agent.taskId === names.first);
  assert.equal(member.status, "waiting");
  assert.equal(member.spawnToolCallId, names.call);
});
test("after a GUI restart, the team still follows its members to their final state", () => {
  const fold = restored(runningTeam());
  tick(fold, { task_id: names.first, status: "completed", final_response: "Done." });
  tick(fold, { task_id: names.second, status: "failed", error: "Could not verify." });
  assert.equal(fold.snapshot().teams[0].status, "failed");
});
test("after a GUI restart, new board snapshots replace the saved team board", () => {
  const fold = restored(runningTeam());
  fold.feed({ type: "extension_event", name: "rubato.team.board.updated", data: {
    teams: [{ team_run_id: names.team, team_name: "Long running team",
      tasks: [{ id: "new-task", subject: "Board after restart", description: "", status: "completed",
        owner: "owner", blocked_by: [] }] }],
  } });
  assert.equal(fold.snapshot().teams[0].board.tasks[0]?.subject, "Board after restart");
});
