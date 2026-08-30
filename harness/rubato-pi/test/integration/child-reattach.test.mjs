import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { launchEnv } from "../../src/brand.mjs";
import { engineChildEnv } from "../helpers/engine-home.mjs";

function startRpc(home, label) {
  const agentDir = join(home, label);
  const cwd = join(home, `${label}-cwd`);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      senpiCliPath(),
      "--mode",
      "rpc",
      "--no-context-files",
      "--no-prompt-templates",
      "-e",
      leadOverlayPath(),
      "-e",
      adapterPath(),
    ],
    {
      cwd,
      env: {
        ...launchEnv(process.env, agentDir),
        HOME: home,
        PATH: process.env.PATH,
        ...engineChildEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return child;
}

function onceResponse(child, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`timeout waiting for ${command}`));
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "response" && rec.command === command) {
          finish(resolve, rec);
        }
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code, signal) => {
      finish(reject, new Error(`rpc exited ${code}/${signal}`));
    });
  });
}

test("a process child stays reachable after the sibling parent is killed", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "rubato-pi-reattach-"));
  const child = startRpc(home, "child");
  const parent = startRpc(home, "parent");
  try {
    const childReady = onceResponse(child, "get_commands", 20000);
    child.stdin.write('{"id":"c1","type":"get_commands"}\n');
    await childReady;

    const parentReady = onceResponse(parent, "get_commands", 20000);
    parent.stdin.write('{"id":"p1","type":"get_commands"}\n');
    await parentReady;

    parent.kill("SIGKILL");

    const stillThere = onceResponse(child, "get_commands", 20000);
    child.stdin.write('{"id":"c2","type":"get_commands"}\n');
    const again = await stillThere;
    const names = (again.data?.commands ?? []).map((c) => c.name);
    assert.ok(names.includes("tasks"));
  } finally {
    child.kill("SIGKILL");
    parent.kill("SIGKILL");
  }
});
