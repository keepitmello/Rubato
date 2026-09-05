#!/usr/bin/env node
import { enableRubatoCompileCache } from "../src/compile-cache.mjs";
import { abandonBootChrome, enterBootChrome } from "../src/boot-chrome.mjs";

enableRubatoCompileCache();

function showCursor() {
  try {
    process.stdout.write("\u001b[?25h");
  } catch {
    // The splash hid the cursor. Restore it if we die before senpi takes the TTY.
  }
}

// An older Node relaunches through this entry point on Node 24; only the owner paints.
if (Number(process.versions.node.split(".")[0]) >= 24) enterBootChrome();
process.once("exit", () => abandonBootChrome());

try {
  const { spawnRubatoPi } = await import("../src/launch.mjs");
  const child = await spawnRubatoPi();
  if (!child) {
    // senpi 를 이 프로세스에서 올렸다. spawnRubatoPi 가 main() 끝까지 await 한다.
    // process.exit 은 senpi 가 직접 한다.
  } else {
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
    child.on("error", (error) => {
      abandonBootChrome();
      showCursor();
      console.error(error.message);
      process.exit(1);
    });
  }
} catch (error) {
  abandonBootChrome();
  showCursor();
  console.error(error.message);
  process.exit(1);
}
