import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURE = join(HERE, "..", "fixtures", "pi-tui-0.84.2-stdin-buffer.js");
const PATCH = join(
  HERE,
  "..",
  "..",
  "..",
  "pi-patches",
  "pi-tui",
  "0.84.2",
  "unicode-input.patch",
);
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];
const STRING_DECODER_IMPORT = 'import { StringDecoder } from "node:string_decoder";';
const STRING_DECODER_LINE = 19; // 1-based; first hunk inserts at this line on pristine stock

function runPatch(args, cwd) {
  try {
    const stdout = execFileSync("patch", args, {
      cwd,
      encoding: "utf8",
      timeout: PATCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error.killed || error.signal) {
      throw new Error(`patch timed out or killed (${error.signal ?? "timeout"}): ${args.join(" ")}`);
    }
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function stagePristine() {
  const dir = mkdtempSync(join(tmpdir(), "pi-unicode-"));
  mkdirSync(join(dir, "dist"));
  cpSync(FIXTURE, join(dir, "dist", "stdin-buffer.js"));
  return dir;
}

function applyPatchFuzzZero() {
  const dir = stagePristine();
  try {
    const dry = runPatch([...PATCH_FLAGS, "--dry-run", "-i", PATCH], dir);
    assert.equal(dry.status, 0, `dry-run failed: ${dry.stdout}\n${dry.stderr}`);
    assert.doesNotMatch(`${dry.stdout}\n${dry.stderr}`, /offset|fuzz [1-9]/i);
    const apply = runPatch([...PATCH_FLAGS, "-s", "-i", PATCH], dir);
    assert.equal(apply.status, 0, `apply failed: ${apply.stdout}\n${apply.stderr}`);
    const lines = readFileSync(join(dir, "dist", "stdin-buffer.js"), "utf8").split("\n");
    assert.equal(
      lines[STRING_DECODER_LINE - 1],
      STRING_DECODER_IMPORT,
      `inserted import must land at line ${STRING_DECODER_LINE} (fuzz-0 still allows offsets; this pin rejects a shifted apply on this fixture)`,
    );
    return join(dir, "dist", "stdin-buffer.js");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function loadPatched() {
  const file = applyPatchFuzzZero();
  const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return { module, cleanup: () => rmSync(dirname(dirname(file)), { recursive: true, force: true }) };
}

async function loadPristine() {
  return import(`${pathToFileURL(FIXTURE).href}?t=${Date.now()}`);
}

function collect(buffer) {
  const events = [];
  buffer.on("data", (sequence) => events.push(sequence));
  return events;
}

function onceData(buffer, expected, timeoutMs = 200) {
  return new Promise((resolve, reject) => {
    const onData = (sequence) => {
      if (sequence === expected) {
        cleanup();
        resolve(sequence);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${JSON.stringify(expected)}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      buffer.off("data", onData);
    };
    buffer.on("data", onData);
  });
}

test("patch applies fuzz-0 clean to pristine stock at the documented line", () => {
  const file = applyPatchFuzzZero();
  rmSync(dirname(dirname(file)), { recursive: true, force: true });
});

test("negative drift rejection: mutated pristine hunk anchor fails to apply", () => {
  const dir = stagePristine();
  try {
    const target = join(dir, "dist", "stdin-buffer.js");
    const original = readFileSync(target, "utf8");
    const anchor = "            // Not an escape sequence - take a single character";
    assert.ok(original.includes(anchor), "pristine fixture must still contain the splitSequences hunk anchor");
    writeFileSync(target, original.replace(anchor, "            // Not an escape sequence - take a single character // drifted"));
    const result = runPatch([...PATCH_FLAGS, "-i", PATCH], dir);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, `drifted tree must reject the patch, got exit ${result.status}: ${out}`);
    assert.match(out, /hunks failed|failed while patching/i);
    assert.doesNotMatch(out, /previously applied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pristine stock exhibits the bug (necessity witness)", async () => {
  const { StdinBuffer } = await loadPristine();
  const buffer = new StdinBuffer({ timeout: 5, escape: 5 });
  const events = collect(buffer);
  try {
    buffer.process(Buffer.from([0xed, 0x95]));
    assert.ok(
      events.join("").includes("�"),
      `expected U+FFFD corruption on pristine stock, got ${JSON.stringify(events)}`,
    );
  } finally {
    buffer.destroy();
  }
});

test("split Korean UTF-8 across Buffer chunks reassembles", async () => {
  const { module, cleanup } = await loadPatched();
  try {
    const buffer = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const events = collect(buffer);
    try {
      buffer.process(Buffer.from([0xed, 0x95]));
      assert.deepEqual(events, [], "partial tail must not emit");
      buffer.process(Buffer.from([0x9c]));
      assert.deepEqual(events, ["한"]);
    } finally {
      buffer.destroy();
    }
  } finally {
    cleanup();
  }
});

test("emoji arrives as one astral sequence via Buffer and via string", async () => {
  const { module, cleanup } = await loadPatched();
  try {
    const fromBuffer = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const bufferEvents = collect(fromBuffer);
    try {
      fromBuffer.process(Buffer.from("😀", "utf8"));
      assert.deepEqual(bufferEvents, ["😀"]);
    } finally {
      fromBuffer.destroy();
    }
    const fromString = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const stringEvents = collect(fromString);
    try {
      fromString.process("😀A");
      assert.deepEqual(stringEvents, ["😀", "A"]);
    } finally {
      fromString.destroy();
    }
  } finally {
    cleanup();
  }
});

test("mixed split escape keys, text, and multibyte keep order", async () => {
  const { module, cleanup } = await loadPatched();
  try {
    const buffer = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const events = collect(buffer);
    try {
      buffer.process(Buffer.from("\x1b", "utf8"));
      buffer.process(Buffer.from("[A", "utf8"));
      buffer.process(Buffer.from("hi", "utf8"));
      buffer.process(Buffer.from([0xed, 0x95]));
      buffer.process(Buffer.from([0x9c]));
      assert.deepEqual(events, ["\x1b[A", "h", "i", "한"]);
    } finally {
      buffer.destroy();
    }
  } finally {
    cleanup();
  }
});

test("lone ESC still flushes; legacy single-high-byte mapping preserved", async () => {
  const { module, cleanup } = await loadPatched();
  try {
    const buffer = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const events = collect(buffer);
    try {
      const esc = onceData(buffer, "\x1b", 200);
      buffer.process("\x1b");
      assert.deepEqual(events, [], "ESC must wait for the escape timer, not emit synchronously");
      await esc;
      assert.deepEqual(events, ["\x1b"]);
      buffer.process(Buffer.from([0xa9]));
      assert.deepEqual(events, ["\x1b", "\x1b)"]);
    } finally {
      buffer.destroy();
    }
  } finally {
    cleanup();
  }
});

test("clear() resets the decoder: no ghost bytes, no replacement char", async () => {
  const { module, cleanup } = await loadPatched();
  try {
    const buffer = new module.StdinBuffer({ timeout: 5, escape: 5 });
    const events = collect(buffer);
    try {
      buffer.process(Buffer.from([0xed, 0x95]));
      assert.deepEqual(events, []);
      buffer.clear();
      buffer.process(Buffer.from("한", "utf8"));
      assert.deepEqual(events, ["한"]);
      buffer.process(Buffer.from([0xe1, 0x84]));
      buffer.destroy();
      buffer.clear();
    } finally {
      try { buffer.destroy(); } catch { /* already destroyed */ }
    }
  } finally {
    cleanup();
  }
});
