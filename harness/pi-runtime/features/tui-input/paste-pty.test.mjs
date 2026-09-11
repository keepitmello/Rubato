import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import { createTerminalSession } from "@code-yeongyu/senpi-pty";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-paste-pty-"));
const outputRoot = join(scratch, "engine");
const SMALL_PASTE = "paste-one\npaste-two\npaste-three";
const LARGE_LINES = Array.from({ length: 15 }, (_, index) => (
  `large-paste-line-${String(index + 1).padStart(2, "0")} ${"x".repeat(70)}`
));
const LARGE_PASTE = LARGE_LINES.join("\n");

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function inputEvents(path) {
  return readJsonLines(path).filter((entry) => entry.kind === "input");
}

function writeBracketedPaste(session, body) {
  const start = "\x1b[200~";
  const end = "\x1b[201~";
  const splitAt = Math.min(body.length, Math.max(1, Math.floor(body.length / 2)));
  assert.equal(session.write(start + body.slice(0, splitAt)).ok, true);
  assert.equal(session.write(body.slice(splitAt) + end).ok, true);
}

const dependencies = await loadPiFeatures([
  "reload",
  "service-tier",
  "input-lifecycle",
  "abort-provenance",
  "extension-rpc",
  "request-run",
  "session-catalog",
  "session-picker",
  "providers",
  "runtime-factories",
]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot,
  features: dependencies,
});
const runtime = resolvePiRuntime({ root: staged.root });

test("native PTY keeps multi-line bracketed paste as one input and stays responsive after a large paste", async (t) => {
  const cwd = join(scratch, "pty-project");
  const homeDir = join(scratch, "home");
  const agentDir = join(scratch, "pty-agent");
  const probeLog = join(scratch, "pty-paste.jsonl");
  const probeExtension = join(scratch, "pty-probe.mjs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(probeExtension, `
import { appendFileSync } from "node:fs";
export default function pastePtyProbe(pi) {
  pi.on("session_start", (event) => {
    appendFileSync(process.env.PASTE_PTY_PROBE_LOG, JSON.stringify({ kind: "start", reason: event.reason }) + "\\n");
  });
  pi.on("input", (event) => {
    appendFileSync(process.env.PASTE_PTY_PROBE_LOG, JSON.stringify({ kind: "input", text: event.text, images: event.images?.length ?? 0 }) + "\\n");
  });
}
`);

  const session = createTerminalSession({
    command: process.execPath,
    args: [
      runtime.patchableCliEntry,
      "--offline",
      "--approve",
      "--no-skills",
      "--no-context-files",
      "--no-themes",
      "--no-extensions",
      "--extension",
      probeExtension,
    ],
    cwd,
    env: withoutNodeOptions(process.env, {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PASTE_PTY_PROBE_LOG: probeLog,
      TERM: "xterm-256color",
      FORCE_COLOR: "0",
    }),
    cols: 100,
    rows: 32,
    timeoutMs: 45_000,
  });
  assert.equal(
    session.backend,
    "native",
    session.unavailableDiagnostic?.cause ?? JSON.stringify(session.native?.diagnostic ?? session.unavailableDiagnostic),
  );

  let output = "";
  let exited = false;
  session.onData((chunk) => { output += chunk.toString("utf8"); });
  session.onExit(() => { exited = true; });
  t.after(async () => {
    if (session.status !== "exited") session.kill("SIGTERM");
    await Promise.race([
      session.waitExit().catch(() => undefined),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (session.status !== "exited") session.kill("SIGKILL");
  });

  await waitFor(() => {
    if (exited) throw new Error(stripVTControlCharacters(output).slice(-2_000));
    return readJsonLines(probeLog).some((entry) => entry.kind === "start" && entry.reason === "startup");
  }, "initial TUI session", 20_000);

  writeBracketedPaste(session, SMALL_PASTE);
  await waitFor(
    () => {
      const visible = stripVTControlCharacters(output);
      return visible.includes("paste-one") && visible.includes("paste-two") && visible.includes("paste-three");
    },
    "small paste rendered with newlines in the editor",
    15_000,
  );
  assert.equal(inputEvents(probeLog).length, 0, "newlines inside bracketed paste must not submit");

  assert.equal(session.write("\r").ok, true);
  const smallInput = await waitFor(
    () => inputEvents(probeLog).find((entry) => String(entry.text).includes("paste-one")),
    "small paste submitted as one input",
    20_000,
  );
  assert.equal(inputEvents(probeLog).length, 1);
  assert.equal(smallInput.text, SMALL_PASTE);

  writeBracketedPaste(session, LARGE_PASTE);
  await waitFor(
    () => stripVTControlCharacters(output).includes("[paste #1 +15 lines]"),
    "large paste collapsed to one editor marker",
    15_000,
  );
  assert.equal(inputEvents(probeLog).length, 1, "large paste must not submit each line");

  assert.equal(session.write("\r").ok, true);
  const largeInput = await waitFor(
    () => inputEvents(probeLog).find((entry) => String(entry.text).includes("large-paste-line-01")),
    "large paste submitted as one expanded input",
    20_000,
  );
  assert.equal(inputEvents(probeLog).length, 2);
  assert.equal(largeInput.text, LARGE_PASTE);
  assert.match(largeInput.text, /large-paste-line-01[\s\S]*large-paste-line-15/);
  assert.equal(largeInput.text.split("\n").length, 15);

  assert.equal(session.write("/quit\r").ok, true);
  await Promise.race([
    session.waitExit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `native PTY did not exit; output=${stripVTControlCharacters(output).slice(-2_000)}`,
    )), 10_000)),
  ]);
  assert.equal(exited, true);
});
