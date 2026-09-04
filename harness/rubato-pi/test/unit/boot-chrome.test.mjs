import test from "node:test";
import assert from "node:assert/strict";
import { abandonBootChrome, enterBootChrome, shouldPaintBootChrome } from "../../src/boot-chrome.mjs";

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

test("enterBootChrome writes alt-screen and a mark, abandon restores it", () => {
  const stdout = { isTTY: true, chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  const stdin = { isTTY: true };
  assert.equal(enterBootChrome([], { stdout, stdin }, {}), true);
  assert.match(stdout.chunks.join(""), /\x1b\[\?1049h/);
  assert.match(stdout.chunks.join(""), /rubato/);
  abandonBootChrome({ stdout });
  assert.match(stdout.chunks.join(""), /\x1b\[\?1049l/);
});
