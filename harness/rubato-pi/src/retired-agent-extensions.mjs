import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The senpi launcher used to write `agentDir/extensions/<name>.js` shims that re-export a module
 * from `harness/rubato-pi/src/extensions/` (only `tps.js` in practice). The launcher that
 * regenerated them is gone and so are the target modules, but stock pi still discovers every
 * file in that directory: one leftover shim makes each session fail to load an extension and
 * exit. Remove exactly the files that carry our banner; anything else there belongs to the user.
 */
export const RETIRED_SHIM_BANNER = "// Owned by rubato-pi. Regenerated on launch from harness/rubato-pi/src/extensions.";

export function removeRetiredAgentExtensions(agentDir, fs = { readdirSync, readFileSync, rmSync }) {
  const dir = join(agentDir, "extensions");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    const path = join(dir, name);
    let head = "";
    try {
      head = fs.readFileSync(path, "utf8").slice(0, RETIRED_SHIM_BANNER.length);
    } catch {
      continue;
    }
    if (head !== RETIRED_SHIM_BANNER) continue;
    fs.rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}
