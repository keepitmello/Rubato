#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import * as enginePaths from "../src/engine-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = process.execPath;
const senpiCli = enginePaths.senpiCli;
const omoExt = enginePaths.rubatoExtension;
const dumpExt = join(root, "tmp/argv-dump.mjs");
const triggerExt = join(root, "tmp/gate4-trigger.mjs");

const home = mkdtempSync(join(tmpdir(), "rubato-pi-gate4-"));
const agentDir = join(home, "agent");
const cwd = join(home, "cwd");
const logDir = join(root, "tmp/probes");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(logDir, { recursive: true });
symlinkSync(join(homedir(), ".agents"), join(home, ".agents"));

const argvLog = join(logDir, "gate4-argv.jsonl");
const notesPath = join(logDir, "gate4-notes.json");
writeFileSync(argvLog, "");

const child = spawn(
  nodeBin,
  [
    senpiCli,
    "--mode",
    "rpc",
    "--no-context-files",
    "--no-prompt-templates",
    "-e",
    omoExt,
    "-e",
    dumpExt,
    "-e",
    triggerExt,
  ],
  {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SENPI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      DO_NOT_TRACK: "1",
      RUBATO_PI_ARGV_LOG: argvLog,
      RUBATO_PI_GATE4_NOTES: notesPath,
      RUBATO_PI_GATE4_SPAWN: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString("utf8");
});

child.stdin.write('{"id":"c1","type":"get_commands"}\n');
await sleep(8000);
child.kill("SIGTERM");
await sleep(500);

let notes = null;
try {
  notes = JSON.parse(readFileSync(notesPath, "utf8"));
} catch {
  notes = null;
}
const dumps = readFileSync(argvLog, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const out = {
  ok: true,
  parentPid: child.pid,
  isolatedHome: home,
  parentArgvExpected: [omoExt, dumpExt, triggerExt],
  dumps,
  notes,
  stderrTail: stderr.slice(-2500),
};
writeFileSync(join(logDir, "gate4.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
