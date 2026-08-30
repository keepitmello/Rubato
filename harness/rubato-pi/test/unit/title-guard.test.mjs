import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  injectTitleGuard,
  installTitleGuard,
  isTerminalModuleUrl,
} from "../../src/title-guard.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";

const piTui = senpiNested("@earendil-works/pi-tui/dist");

function makeFakeTerminal() {
  const writes = [];
  class FakeTerminal {
    setTitle(title) {
      const sanitized = String(title).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      writes.push(`\x1b]0;${sanitized}\x07`);
    }
  }
  return { FakeTerminal, writes };
}

test("repeated identical titles emit a single OSC sequence", () => {
  const { FakeTerminal, writes } = makeFakeTerminal();
  assert.equal(installTitleGuard(FakeTerminal.prototype), true);

  const term = new FakeTerminal();
  for (let i = 0; i < 50; i += 1) term.setTitle("rubato - bash");

  assert.deepEqual(writes, ["\x1b]0;rubato - bash\x07"]);
});

test("a changed title still reaches the terminal", () => {
  const { FakeTerminal, writes } = makeFakeTerminal();
  installTitleGuard(FakeTerminal.prototype);

  const term = new FakeTerminal();
  term.setTitle("rubato - bash");
  term.setTitle("rubato - bash");
  term.setTitle("rubato - read");
  term.setTitle("rubato - read");
  term.setTitle("rubato - bash");

  assert.deepEqual(writes, [
    "\x1b]0;rubato - bash\x07",
    "\x1b]0;rubato - read\x07",
    "\x1b]0;rubato - bash\x07",
  ]);
});

test("two terminal instances keep independent title state", () => {
  const { FakeTerminal, writes } = makeFakeTerminal();
  installTitleGuard(FakeTerminal.prototype);

  const a = new FakeTerminal();
  const b = new FakeTerminal();
  a.setTitle("one");
  b.setTitle("one");

  assert.equal(writes.length, 2);
});

test("the guard is installed at most once per prototype", () => {
  const { FakeTerminal } = makeFakeTerminal();
  assert.equal(installTitleGuard(FakeTerminal.prototype), true);
  assert.equal(installTitleGuard(FakeTerminal.prototype), false);
});

test("titles differing only in stripped control characters are deduped", () => {
  const { FakeTerminal, writes } = makeFakeTerminal();
  installTitleGuard(FakeTerminal.prototype);

  const term = new FakeTerminal();
  term.setTitle("rubato - bash");
  term.setTitle("rubato\x07 - bash");

  assert.deepEqual(writes, ["\x1b]0;rubato - bash\x07"]);
});

test("injects the guard into the pinned pi-tui terminal module", () => {
  const source = readFileSync(join(piTui, "terminal.js"), "utf8");
  assert.match(source, /class ProcessTerminal/);
  assert.match(source, /setTitle\(title\)/);

  const next = injectTitleGuard(source, "file:///guard.mjs");
  assert.notEqual(next, source);
  assert.match(next, /__rubatoInstallTitleGuard\(ProcessTerminal\.prototype\)/);

  // Injection is idempotent, so a re-resolved module is not double wrapped.
  assert.equal(injectTitleGuard(next, "file:///guard.mjs"), next);
});

test("only the pi-tui terminal module is targeted", () => {
  assert.equal(
    isTerminalModuleUrl("file:///x/@earendil-works/pi-tui/dist/terminal.js"),
    true,
  );
  assert.equal(
    isTerminalModuleUrl("file:///x/@earendil-works/pi-tui/dist/terminal-image.js"),
    false,
  );
  assert.equal(
    isTerminalModuleUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js"),
    false,
  );
});
