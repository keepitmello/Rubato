import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { patchInteractiveTuiInput } from "../../../pi-runtime/features/tui-input/patches.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const chromeUrl = new URL("../../src/boot-chrome.mjs", import.meta.url).href;
const interactivePath = join(
  fileURLToPath(new URL("../../../pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", import.meta.url)),
);

test("stock interactive patch calls handoffBootChromeForStockPi immediately before ui.start", () => {
  const src = readFileSync(interactivePath, "utf8");
  const next = patchInteractiveTuiInput(src);
  assert.match(next, /RUBATO_BOOT_CHROME_HREF[\s\S]*handoffBootChromeForStockPi[\s\S]*this\.ui\.start\(\)/);
});

test("stock-pi handoff leaves zero splash frames after engine output", async () => {
  const source = `
    import { EventEmitter } from "node:events";
    import { enterBootChrome, handoffBootChromeForStockPi } from ${JSON.stringify(chromeUrl)};
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 80, rows: 24, fd: 1,
      write() { throw Error("boot output must not depend on the main-thread stream"); },
    });
    const io = { stdout, stdin: { isTTY: true } };
    enterBootChrome([], io, { TERM: "xterm-256color" });
    process.stderr.write("ENGINE_READY");
    await handoffBootChromeForStockPi();
    process.stdout.write("TUI_START");
    await new Promise((r) => setTimeout(r, 250));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, errors);
    const after = output.split("TUI_START")[1] ?? "";
    assert.equal((after.match(/\x1b\[\?2026h/g) ?? []).length, 0, "splash frames after TUI_START: " + after.length);
    assert.match(output, /TUI_START/);
  } finally {
    clearTimeout(timeout);
  }
});
