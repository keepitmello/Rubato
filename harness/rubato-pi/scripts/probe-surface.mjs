#!/usr/bin/env node
// Isolated RPC surface probe. Does not touch ~/.rubato or ~/.senpi.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as enginePaths from "../src/engine-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const nodeBin = process.execPath;
const senpiCli = enginePaths.senpiCli;
const omoExt = enginePaths.rubatoExtension;
const rubatoDir = enginePaths.enginePluginDir;

const extra = process.argv.slice(2);
const mode = extra[0] ?? "bare";
const rest = mode === "custom" ? extra.slice(2) : extra.slice(1);
const customPath = mode === "custom" ? resolve(extra[1] ?? "") : undefined;

function extensionArgs(kind, extraPath) {
  if (kind === "file") return ["-e", omoExt];
  if (kind === "dir") return ["-e", rubatoDir];
  if (kind === "bare") return [];
  if (kind === "custom") return ["-e", extraPath];
  throw new Error(`unknown mode ${kind}`);
}

function readJsonlResponses(child, wanted, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const got = new Map();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms; have ${[...got.keys()].join(",") || "nothing"}`));
    }, timeoutMs);
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
        if (rec.type === "response" && rec.command && !got.has(rec.command)) {
          got.set(rec.command, rec);
          if (wanted.every((name) => got.has(name))) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolvePromise(got);
          }
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (wanted.every((name) => got.has(name))) return;
      clearTimeout(timer);
      reject(new Error(`senpi exited ${code}/${signal} before responses`));
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "rubato-pi-probe-"));
const agentDir = join(home, "agent");
const cwd = join(home, "cwd");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
if (process.env.RUBATO_PI_LINK_AGENTS === "1") {
  const agents = join(homedir(), ".agents");
  symlinkSync(agents, join(home, ".agents"));
}

const args = [
  senpiCli,
  "--mode",
  "rpc",
  "--no-context-files",
  "--no-prompt-templates",
  ...extensionArgs(mode, customPath),
  ...rest,
];

const child = spawn(nodeBin, args, {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    SENPI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    DO_NOT_TRACK: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString("utf8");
});

child.stdin.write('{"id":"c1","type":"get_commands"}\n');
child.stdin.write('{"id":"c2","type":"get_loaded_surfaces"}\n');

const wanted = ["get_commands", "get_loaded_surfaces"];
let result;
try {
  result = await readJsonlResponses(child, wanted, 45000);
} catch (err) {
  child.kill("SIGKILL");
  writeFileSync(join(home, "stderr.txt"), stderr);
  console.error(JSON.stringify({ ok: false, mode, error: String(err), home, stderrTail: stderr.slice(-2000) }, null, 2));
  process.exit(1);
}
child.kill("SIGTERM");

const commands = result.get("get_commands")?.data?.commands ?? [];
const surfaces = result.get("get_loaded_surfaces")?.data ?? {};
const skills = commands.filter((c) => c.source === "skill").map((c) => c.name);
const extCmds = commands.filter((c) => c.source !== "skill").map((c) => c.name);

const out = {
  ok: true,
  mode,
  extra: rest,
  pin: {
    node: process.version,
    senpiCli,
    omoExt,
  },
  counts: {
    commands: commands.length,
    extensionCommands: extCmds.length,
    skills: skills.length,
    extensions: (surfaces.extensions ?? []).length,
    mcpServers: (surfaces.mcpServers ?? []).length,
  },
  skills,
  extensionCommands: extCmds,
  extensions: (surfaces.extensions ?? []).map((e) => ({ name: e.name, path: e.path, enabled: e.enabled })),
  mcpServers: (surfaces.mcpServers ?? []).map((s) => s.name ?? s),
  stderrTail: stderr.slice(-1500),
  isolatedHome: home,
};

console.log(JSON.stringify(out, null, 2));
process.exit(0);
