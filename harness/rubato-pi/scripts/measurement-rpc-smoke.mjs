#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const runDir = process.env.RUBATO_SMOKE_RUN_DIR;
if (!runDir) throw new Error("RUBATO_SMOKE_RUN_DIR is required");
const timeoutMs = Number(process.env.RUBATO_SMOKE_TIMEOUT_MS ?? 60_000);
mkdirSync(runDir, { recursive: true });
const stdout = createWriteStream(join(runDir, "stdout.jsonl"), { flags: "a" });
const stderr = createWriteStream(join(runDir, "stderr.log"), { flags: "a" });
const launcher = new URL("../../scripts/rubato-pi.sh", import.meta.url).pathname;
const prompt = process.env.RUBATO_SMOKE_PROMPT
  ?? "Use the read tool exactly once to read /Users/wy/Github-repos/Rubato/harness/rubato-pi/package.json, then reply with only its package name.";
const child = spawn(launcher, ["--mode", "rpc", "--model", process.env.RUBATO_SMOKE_MODEL ?? "xai/grok-4.6"], {
  cwd: process.env.RUBATO_SMOKE_CWD ?? runDir,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let terminal;
child.stdout.on("data", (chunk) => {
  stdout.write(chunk);
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const event = JSON.parse(line);
      if (event.type === "agent_end" && event.willRetry !== true) {
        terminal = event;
        child.stdin.end();
      }
    } catch {}
  }
});
child.stderr.on("data", (chunk) => stderr.write(chunk));
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
}, timeoutMs);
child.once("spawn", () => child.stdin.write(`${JSON.stringify({ id: "measurement-smoke", type: "prompt", message: prompt })}\n`));
child.once("close", (code, signal) => {
  clearTimeout(timer);
  stdout.end();
  stderr.end();
  const result = { code, signal, agentEnd: terminal !== undefined, aborted: terminal?.aborted === true };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = terminal && code === 0 ? 0 : 1;
});
