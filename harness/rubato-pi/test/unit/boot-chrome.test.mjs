import test from "node:test";
import assert from "node:assert/strict";
import {
  abandonBootChrome,
  composeBootChrome,
  enterBootChrome,
  releaseBootChrome,
  resetBootChromeForTests,
  setBootChromeStatus,
  shouldPaintBootChrome,
} from "../../src/boot-chrome.mjs";

test("boot chrome stays off for print, help, CI, and pipes", () => {
  const io = { stdout: { isTTY: true }, stdin: { isTTY: true } };
  assert.equal(shouldPaintBootChrome([], io, {}), true);
  assert.equal(shouldPaintBootChrome(["--print", "x"], io, {}), false);
  assert.equal(shouldPaintBootChrome(["--mode", "rpc"], io, {}), false);
  assert.equal(shouldPaintBootChrome(["app-server"], io, {}), false);
  assert.equal(shouldPaintBootChrome(["--help"], io, {}), false);
  assert.equal(shouldPaintBootChrome(["-v"], io, {}), false);
  assert.equal(shouldPaintBootChrome([], io, { CI: "1" }), false);
  assert.equal(shouldPaintBootChrome([], { stdout: { isTTY: false }, stdin: { isTTY: true } }, {}), false);
});

test("composeBootChrome keeps the logo and a loading status", () => {
  const wide = composeBootChrome({ env: {}, columns: 80, status: "엔진을 불러오는 중", frame: 0 });
  assert.match(wide, /█▀▄  █ █  █▀▄/);
  assert.match(wide, /엔진을 불러오는 중/);
  assert.match(wide, /⠋/);
  const narrow = composeBootChrome({ env: {}, columns: 20, status: "준비하는 중", frame: 1 });
  assert.doesNotMatch(narrow, /█▀▄/);
  assert.match(narrow, /준비하는 중/);
});

test("enterBootChrome writes alt-screen and the logo, abandon restores it", () => {
  resetBootChromeForTests();
  const stdout = { isTTY: true, columns: 80, chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  const stdin = { isTTY: true };
  assert.equal(enterBootChrome([], { stdout, stdin }, {}), true);
  const first = stdout.chunks.join("");
  assert.match(first, /\x1b\[\?1049h/);
  assert.match(first, /█▀▄  █ █  █▀▄/);
  assert.match(first, /엔진을 불러오는 중/);
  assert.doesNotMatch(first, /^\x1b\[2m  rubato/m);
  assert.equal(setBootChromeStatus("에디터를 준비하는 중", { stdout, stdin }), true);
  assert.match(stdout.chunks.join(""), /에디터를 준비하는 중/);
  releaseBootChrome();
  stdout.chunks.length = 0;
  assert.equal(setBootChromeStatus("should not paint", { stdout, stdin }), false);
  assert.equal(stdout.chunks.join(""), "");
  abandonBootChrome({ stdout });
  assert.match(stdout.chunks.join(""), /\x1b\[\?1049l/);
  resetBootChromeForTests();
});
