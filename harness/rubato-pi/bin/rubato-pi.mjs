#!/usr/bin/env node
import { spawnRubatoPi } from "../src/launch.mjs";

function showCursor() {
  try {
    process.stdout.write("\u001b[?25h");
  } catch {
    // The splash hid the cursor. Restore it if we die before senpi takes the TTY.
  }
}

let child;
try {
  child = await spawnRubatoPi();
} catch (error) {
  showCursor();
  console.error(error.message);
  process.exit(1);
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  showCursor();
  console.error(error.message);
  process.exit(1);
});
