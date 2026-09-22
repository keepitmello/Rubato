import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listenerPid, processTable } from "../../scripts/restart-profile-engine.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stand in for spawnSync, so a pgrep that reports nothing can be replayed exactly. */
function runner({ pgrep = "", psRows = [] }) {
  return (command, args) => {
    if (command === "pgrep") return { status: pgrep === "" ? 1 : 0, stdout: pgrep };
    if (args[0] === "-o" && args[2] === "-p") {
      const row = psRows.find((line) => Number(line.trim().split(/\s+/)[0]) === Number(args[3]));
      return row === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: row.replace(/^\s*\d+\s+/, "") };
    }
    if (args[0] === "-eo") return { status: 0, stdout: psRows.join("\n") };
    return { status: 1, stdout: "" };
  };
}

// Measured on the machine this was written on: `pgrep -f node` named three node processes
// and omitted the running profile engine, while `ps -p <pid> -o command=` printed it in
// full. Trusting pgrep alone reported no-pid, left the old engine running, and the machine
// kept serving the model list from before the update.
test("#given pgrep names nothing #when the process table is read #then ps still supplies the row", () => {
  const rows = processTable(runner({ psRows: [" 4321 node /opt/x/cli.mjs --agent-dir /agent --runtime-root /engine"] }));

  assert.equal(rows.get(4321), "node /opt/x/cli.mjs --agent-dir /agent --runtime-root /engine");
});

test("#given pgrep names a pid #when the process table is read #then ps supplies that pid's command line", () => {
  const rows = processTable(runner({
    pgrep: "4321\n",
    psRows: [" 4321 node /opt/x/cli.mjs --agent-dir /agent"],
  }));

  assert.equal(rows.get(4321), "node /opt/x/cli.mjs --agent-dir /agent");
});

// `--agent-dir /x/agent` is a prefix of `--agent-dir /x/agent2`. Matching the prefix would
// SIGTERM a profile that was never the one being restarted.
test("#given an engine whose dir merely starts with the target #when the listener pid is looked up #then it is not mistaken for a match", () => {
  const run = runner({
    psRows: [" 4321 node /opt/x/cli.mjs --agent-dir /profiles/agent2"],
  });

  assert.equal(listenerPid("/profiles/agent", run), undefined, "the longer dir must not read as the shorter one");
  assert.equal(listenerPid("/profiles/agent2", run), 4321, "and the row is reachable under its own dir");
});

async function scratch(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A process whose command line looks exactly like the profile engine's. */
async function spawnFakeEngine(t, agentDir) {
  const dir = await scratch(t, "rubato-fake-engine-");
  const entry = join(dir, "cli.mjs");
  await writeFile(entry, "setTimeout(() => {}, 30000);\n");
  const child = spawn(process.execPath, [entry, "--agent-dir", agentDir], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  return child;
}

/** The process table is read by spawning ps, so a just-created process is not guaranteed
 *  to be visible on the first look. Wait for the lookup to see it before asserting on it. */
async function waitForPid(agentDir, pid) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (listenerPid(agentDir) === pid) return true;
    await sleep(50);
  }
  return false;
}

test("#given a running engine for this agent dir #when the listener pid is looked up #then that pid is found", async (t) => {
  const agentDir = await scratch(t, "rubato-agent-");
  const child = await spawnFakeEngine(t, agentDir);

  assert.equal(await waitForPid(agentDir, child.pid), true, "the engine's own pid must be found");
  assert.equal(listenerPid(agentDir), child.pid);
});

test("#given an engine for a different agent dir #when the listener pid is looked up #then nothing matches", async (t) => {
  const agentDir = await scratch(t, "rubato-agent-");
  const otherDir = await scratch(t, "rubato-other-");
  const child = await spawnFakeEngine(t, otherDir);
  // Prove the process is visible before asserting that the other dir does not match it:
  // otherwise this passes because the lookup saw nothing at all.
  assert.equal(await waitForPid(otherDir, child.pid), true, "the fake engine must be visible to the lookup");

  assert.equal(listenerPid(agentDir), undefined);
});
