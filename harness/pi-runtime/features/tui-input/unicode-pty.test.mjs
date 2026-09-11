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
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";

import { createTerminalSession } from "@code-yeongyu/senpi-pty";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { patchStdinBufferUnicode } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-unicode-pty-"));
const outputRoot = join(scratch, "engine");
const HANGUL_GA = new Uint8Array([0xea, 0xb0, 0x80]);
const COMPOSED_HANGUL = "한글";
const EXPECTED_INPUT = `${COMPOSED_HANGUL}가`;

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function collectStdinChunks(StdinBuffer, chunks) {
  const received = [];
  const buffer = new StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  buffer.on("data", (chunk) => received.push(chunk));
  for (const chunk of chunks) buffer.process(Buffer.from(chunk));
  return received;
}

const stockStdinPath = join(
  sourceRoot,
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js",
);

const bootFeatures = await loadPiFeatures([
  "reload",
  "service-tier",
  "input-lifecycle",
  "abort-provenance",
  "extension-rpc",
  "request-run",
  "session-catalog",
  "providers",
  "runtime-factories",
  "context-window",
  "tui-input",
]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot,
  features: bootFeatures,
});
const runtime = resolvePiRuntime({ root: staged.root });

test("stock StdinBuffer corrupts a split 3-byte Hangul chunk; tui-input patch does not", async () => {
  const stockSource = readFileSync(stockStdinPath, "utf8");
  assert.equal(stockSource.includes("StringDecoder"), false);
  const patchedSource = patchStdinBufferUnicode(stockSource);
  assert.equal(patchedSource.includes("StringDecoder"), true);
  assert.equal(patchedSource.includes("codePointAt"), true);

  const stockFile = join(scratch, "stdin-stock.mjs");
  const patchedFile = join(scratch, "stdin-patched.mjs");
  writeFileSync(stockFile, stockSource);
  writeFileSync(patchedFile, patchedSource);
  const stockMod = await import(pathToFileURL(stockFile).href + "?unicode-stock");
  const patchedMod = await import(pathToFileURL(patchedFile).href + "?unicode-patched");

  const splitOneTwo = [HANGUL_GA.subarray(0, 1), HANGUL_GA.subarray(1)];
  const stockSplit = collectStdinChunks(stockMod.StdinBuffer, splitOneTwo);
  assert.notEqual(stockSplit.join(""), "가");
  assert.equal(stockSplit.includes("가"), false);
  assert.deepEqual(stockSplit, ["\x1bj", "\uFFFD", "\uFFFD"]);

  const patchedSplit = collectStdinChunks(patchedMod.StdinBuffer, splitOneTwo);
  assert.deepEqual(patchedSplit, ["가"]);

  const splitBytes = [HANGUL_GA.subarray(0, 1), HANGUL_GA.subarray(1, 2), HANGUL_GA.subarray(2)];
  assert.deepEqual(collectStdinChunks(stockMod.StdinBuffer, splitBytes), ["\x1bj", "\x1b0", "\x1b\x00"]);
  assert.deepEqual(collectStdinChunks(patchedMod.StdinBuffer, splitBytes), ["가"]);
});

test("native PTY keeps composing Hangul and split UTF-8 intact", async (t) => {
  const unicode = staged.receipt.files.find((entry) => entry.path.endsWith("dist/stdin-buffer.js"));
  assert.ok(unicode?.patches.includes("tui-input/tui-input:unicode"), JSON.stringify(unicode?.patches));

  const isolatedHome = join(scratch, "home");
  const agentDir = join(scratch, "pty-agent");
  const cwd = join(scratch, "pty-project");
  const probeLog = join(scratch, "pty-unicode.jsonl");
  const probeExtension = join(scratch, "pty-unicode-probe.mjs");
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(probeExtension, `
import { appendFileSync } from "node:fs";
export default function unicodePtyProbe(pi) {
  pi.on("session_start", (event) => {
    appendFileSync(process.env.TUI_UNICODE_PROBE_LOG, JSON.stringify({ kind: "start", reason: event.reason }) + "\\n");
  });
  pi.on("input", (event) => {
    appendFileSync(process.env.TUI_UNICODE_PROBE_LOG, JSON.stringify({ kind: "input", text: event.text }) + "\\n");
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
      HOME: isolatedHome,
      PI_CODING_AGENT_DIR: agentDir,
      SENPI_CODING_AGENT_DIR: join(scratch, "senpi-agent"),
      RUBATO_PI_CODING_AGENT_DIR: join(scratch, "rubato-agent"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_DATA_HOME: join(isolatedHome, ".local/share"),
      XDG_STATE_HOME: join(isolatedHome, ".local/state"),
      TUI_UNICODE_PROBE_LOG: probeLog,
      TERM: "xterm-256color",
      FORCE_COLOR: "0",
      LANG: "en_US.UTF-8",
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
  const outputDecoder = new StringDecoder("utf8");
  session.onData((chunk) => { output += outputDecoder.write(Buffer.from(chunk)); });
  session.onExit(() => { exited = true; });
  const stopOwnedProcess = () => {
    if (session.status === "exited") return;
    session.kill("SIGTERM");
  };
  t.after(async () => {
    stopOwnedProcess();
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

  for (const syllable of COMPOSED_HANGUL) {
    assert.equal(session.write(syllable).ok, true);
    await sleep(15);
  }
  await waitFor(
    () => stripVTControlCharacters(output).includes(COMPOSED_HANGUL),
    "composed Hangul rendered in TUI",
    20_000,
  );

  assert.equal(session.write(HANGUL_GA.subarray(0, 1)).ok, true);
  await sleep(40);
  assert.equal(session.write(HANGUL_GA.subarray(1, 2)).ok, true);
  await sleep(40);
  assert.equal(session.write(HANGUL_GA.subarray(2)).ok, true);
  await sleep(40);

  assert.equal(session.write("\r").ok, true);
  const typed = await waitFor(() => {
    return readJsonLines(probeLog).find((entry) => entry.kind === "input");
  }, `submitted Hangul input event; visible=${stripVTControlCharacters(output).slice(-1_500)}`, 20_000);

  assert.equal(typed.text, EXPECTED_INPUT);
  assert.equal(typed.text.includes("\uFFFD"), false);
  assert.doesNotMatch(typed.text, /[\uD800-\uDFFF]/);
  assert.equal((typed.text.match(/한/g) || []).length, 1);
  assert.equal((typed.text.match(/글/g) || []).length, 1);
  assert.equal((typed.text.match(/가/g) || []).length, 1);
  assert.match(stripVTControlCharacters(output), /한글가/);

  assert.equal(session.write("/quit\r").ok, true);
  await Promise.race([
    session.waitExit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `native PTY did not exit; output=${stripVTControlCharacters(output).slice(-2_000)}`,
    )), 10_000)),
  ]);
  assert.equal(exited, true);
});
