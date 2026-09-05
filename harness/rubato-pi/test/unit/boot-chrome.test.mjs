import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stripVTControlCharacters as plain } from "node:util";
import {
  abandonBootChrome, composeBootChrome, enterBootChrome, finishBootChrome,
  releaseBootChrome, resetBootChromeForTests, setBootChromeStatus, shouldPaintBootChrome,
} from "../../src/boot-chrome.mjs";
import { INTRO_MS, RELEASE_MS, CLEAR_MS, WORDMARK, renderResonance } from "../../src/boot-resonance.mjs";

const chromeUrl = new URL("../../src/boot-chrome.mjs", import.meta.url).href;
test("release gets a larger canvas without scaling or shifting the held logo", () => {
  const options = { time: 6000, columns: 80, rows: 28, env: { NO_COLOR: "" } };
  const held = renderResonance(options).map(plain);
  const field = {
    ...options, columns: 119, rows: 40, artColumns: 80, artRows: 28,
    offsetColumns: 19, offsetRows: 2, releaseRadius: 165,
  };
  const beginning = renderResonance({ ...field, release: 0 }).map(plain);
  assert.deepEqual(beginning.slice(2, 30).map((row) => row.slice(19, 99)), held);
  const expanded = renderResonance({ ...field, release: 1300 }).map(plain);
  const outside = expanded.flatMap((row, y) => [...row].filter((c, x) =>
    c !== " " && (y < 2 || y >= 30 || x < 19 || x >= 99)));
  assert(outside.length > 30, `only ${outside.length} particles escaped the old canvas`);
  assert(expanded.every((row) => row.length === 119));
  assert.equal(renderResonance({ ...field, release: RELEASE_MS }).map(plain).join("").trim(), "");
});

async function runRenderer(body) {
  const source = `
    import { EventEmitter } from "node:events";
    import { enterBootChrome, finishBootChrome, abandonBootChrome, setBootChromeStatus } from ${JSON.stringify(chromeUrl)};
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 80, rows: 24, fd: 1,
      write() { throw Error("boot output must not depend on the main-thread stream"); },
    });
    const io = { stdout, stdin: { isTTY: true } };
    enterBootChrome([], io, { TERM: "xterm-256color" });
    ${body}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "", beforeReady = "", ready = false;
  child.stdout.on("data", (chunk) => { output += chunk; if (!ready) beforeReady += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; if (errors.includes("ENGINE_READY")) ready = true; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, errors);
    return { output, beforeReady };
  } finally { clearTimeout(timeout); }
}
function width(text) {
  return [...text].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3]/u.test(c) ? 2 : 1), 0);
}

test("boot chrome stays off for headless, help, CI, disabled splash, and pipes", async () => {
  const io = { stdout: { isTTY: true }, stdin: { isTTY: true } };
  assert.equal(shouldPaintBootChrome([], io, {}), true);
  for (const args of [["--print", "x"], ["--mode", "rpc"], ["app-server"], ["--help"], ["-v"]]) {
    assert.equal(shouldPaintBootChrome(args, io, {}), false);
  }
  for (const env of [{ CI: "1" }, { TERM: "dumb" }, { RUBATO_BOOT_CHROME: "0" }, { RUBATO_NO_SPLASH: "1" }]) {
    assert.equal(shouldPaintBootChrome([], io, env), false);
  }
  assert.equal(shouldPaintBootChrome([], { stdout: { isTTY: false }, stdin: { isTTY: true } }, {}), false);
  resetBootChromeForTests();
  assert.equal(await finishBootChrome(), false);
});

test("centered frames fit wide, narrow, short, and one-cell terminals without wrapping", () => {
  for (const [columns, rows] of [[120, 40], [80, 24], [30, 10], [12, 5], [1, 1], [80, 3]]) {
    const output = composeBootChrome({ columns, rows, time: INTRO_MS, status: "에디터를 준비하는 중", env: {} });
    const matches = [...output.matchAll(/\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)];
    assert.equal(matches.length, rows);
    for (const [, row, content] of matches) {
      assert(Number(row) <= rows);
      assert(width(plain(content)) <= columns - 1, `${columns}x${rows}: ${plain(content)}`);
    }
    assert(!output.includes("\n"));
    if (columns >= 12 && rows >= 3) assert(output.includes(WORDMARK));
  }
  const output = composeBootChrome({ columns: 120, rows: 40, time: INTRO_MS });
  const wordmarkRow = [...output.matchAll(/\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)]
    .find(([, , content]) => content.includes(WORDMARK));
  assert(wordmarkRow);
  assert(plain(wordmarkRow[2]).startsWith(" ".repeat(56)));
});

test("one real status replaces history; color opt-out and text sanitation survive", () => {
  const output = composeBootChrome({
    env: { NO_COLOR: "" }, time: INTRO_MS, status: "현재\x1b[31m 상태\n준비 중",
  });
  assert(!output.includes("\x1b[38;"));
  assert(!output.includes("\x1b[31m"));
  assert(plain(output).includes("현재 상태 준비 중"));
  assert(!output.includes("거의 준비됐어"));
});

test("renderer moves while the engine thread is synchronously blocked; no late paints", async () => {
  const { output, beforeReady } = await runRenderer(`
    const started = Date.now();
    while (Date.now() - started < 1800) {} // actual blocked event loop, not a fake clock
    process.stderr.write("ENGINE_READY");
    const finished = finishBootChrome();
    if (finished !== finishBootChrome()) throw Error("duplicate handoff");
    if (!await finished) throw Error("handoff failed");
    const duration = Date.now() - started;
    if (duration < ${INTRO_MS + RELEASE_MS + CLEAR_MS - 100} || duration > 10000) throw Error("duration " + duration);
    if (setBootChromeStatus("late")) throw Error("late status accepted");
    process.stdout.write("HANDOFF");
    await new Promise(r => setTimeout(r, 200));
  `);
  assert((beforeReady.match(/\x1b\[\?2026h/g) ?? []).length >= 12, "worker must paint before blocked engine returns");
  assert(beforeReady.startsWith("\x1b[?1049h"), "screen entry must precede every independent worker frame");
  assert.match(plain(beforeReady), /[\u2801-\u28ff]/u);
  assert(!plain(beforeReady).includes("준비 완료"));
  assert(plain(output).includes("준비 완료"));
  assert.equal(output.split("HANDOFF")[1], "");
});

test("slow engine extends the middle rather than restarting the intro", async () => {
  const { output, beforeReady } = await runRenderer(`
    setBootChromeStatus("에디터를 준비하는 중");
    await new Promise(r => setTimeout(r, 5200));
    process.stderr.write("ENGINE_READY");
    const readyAt = Date.now();
    if (!await finishBootChrome()) throw Error("handoff failed");
    const tail = Date.now() - readyAt;
    if (tail < ${RELEASE_MS + CLEAR_MS} || tail > 3800) throw Error("replayed intro: " + tail);
    process.stdout.write("HANDOFF");
  `);
  assert(plain(beforeReady).includes("에디터를 준비하는 중"));
  assert(!plain(beforeReady).includes("준비 완료"));
  assert(plain(output).includes("준비 완료"));
});

test("worker resize and cancellation acknowledge before the next terminal owner", async () => {
  const { output } = await runRenderer(`
    await new Promise(r => setTimeout(r, 150));
    stdout.columns = 20; stdout.rows = 8; stdout.emit("resize");
    process.stdout.write("RESIZED");
    await new Promise(r => setTimeout(r, 200));
    const finished = finishBootChrome();
    abandonBootChrome();
    if (await finished !== false) throw Error("cancel failed");
    if (stdout.listenerCount("resize")) throw Error("resize listener leaked");
    process.stdout.write("CANCELLED");
    await new Promise(r => setTimeout(r, 200));
  `);
  // Resize is asynchronous: a frame already writing may precede its first repaint.
  // The final acknowledged-size frame must fit; cancellation remains strict.
  const resizedFrames = output.split("RESIZED")[1].split("\x1b[?2026h").slice(1);
  assert(resizedFrames.length > 0);
  assert(!resizedFrames.at(-1).includes("\x1b[9;1H"));
  assert(output.includes("\x1b[?1049l"));
  assert.equal(output.split("CANCELLED")[1], "");
});

test("Resonance is deterministic, expands before fading, and fully clears", () => {
  const options = { time: 10000, columns: 80, rows: 28, env: { NO_COLOR: "" } };
  const held = renderResonance(options).map(plain).join("");
  assert.equal(renderResonance(options).map(plain).join(""), held);
  const spread = renderResonance({ ...options, release: 1300 }).map(plain).join("");
  assert(spread.replaceAll(" ", "").length > held.replaceAll(" ", "").length);
  assert.equal(renderResonance({ ...options, release: RELEASE_MS }).map(plain).join("").trim(), "");
});
