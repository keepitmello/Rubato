import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimTask, listTasks, updateTask } from "../../src/member-board.mjs";

function seed(status, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-board-"));
  const team = "11111111-1111-4111-8111-111111111111";
  const dir = join(root, "runtime", team, "tasks");
  mkdirSync(dir, { recursive: true });
  const task = {
    version: 1,
    id: "1",
    subject: "do",
    description: "do it",
    status,
    blockedBy: [],
    blocks: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
  writeFileSync(join(dir, "1.json"), `${JSON.stringify(task, null, 2)}\n`);
  return { root, team };
}

test("claim is first-writer-wins and blocked tasks stay pending", async () => {
  const { root, team } = seed("pending");
  const claimed = await claimTask(root, team, "1", "alpha");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.owner, "alpha");
  await assert.rejects(claimTask(root, team, "1", "beta"), /already_claimed/);

  const blocked = seed("pending");
  writeFileSync(
    join(blocked.root, "runtime", blocked.team, "tasks", "2.json"),
    `${JSON.stringify({
      version: 1,
      id: "2",
      subject: "later",
      description: "later",
      status: "pending",
      blockedBy: ["1"],
      blocks: [],
      createdAt: 1,
      updatedAt: 1,
    }, null, 2)}\n`,
  );
  await assert.rejects(claimTask(blocked.root, blocked.team, "2", "alpha"), /blocked by/);

});

test("cross-owner updates are rejected and metadata can record budget return", async () => {
  const { root, team } = seed("claimed", { owner: "alpha", claimedAt: 1 });
  await assert.rejects(updateTask(root, team, "1", "beta", "in_progress"), /cross-owner/);
  const updated = await updateTask(root, team, "1", "alpha", "in_progress", {
    budget_return: true,
    done_evidence: "covered files A,B",
  });
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.metadata.budget_return, true);
  const listed = await listTasks(root, team, { owner: "alpha" });
  assert.equal(listed.length, 1);
});
