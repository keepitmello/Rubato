import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Existing server-compaction tests exercise the legacy policy explicitly.
// New context-notes tests select their mode in fixtures and also run here.
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(join(root, "test/unit")).filter((name) => name.endsWith(".test.mjs")).sort()
  .map((name) => join(root, "test/unit", name));
const result = spawnSync(process.execPath, ["--import", join(root, "src/no-changelog-register.mjs"), "--test", ...tests],
  { stdio: "inherit", cwd: root, env: { ...process.env, RUBATO_CONTEXT_MODE: "summary" } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
