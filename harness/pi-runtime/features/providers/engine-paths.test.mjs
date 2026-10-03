import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("./engine-paths.mjs", import.meta.url));
const stagedRel = "dist/rubato-features/providers/src/engine-paths.mjs";

function plant(piAiRoot, codingAgentRoot) {
  mkdirSync(join(piAiRoot, "dist/rubato-features/providers/src"), { recursive: true });
  copyFileSync(source, join(piAiRoot, stagedRel));
  mkdirSync(codingAgentRoot, { recursive: true });
  writeFileSync(join(codingAgentRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
}

// credential-import loads <senpiDir>/dist/core/auth-storage.js; senpiDir must be the
// coding-agent package in both the 0.86.1 nested and the 1.0.1 hoisted install layouts.
for (const layout of ["nested", "hoisted"]) {
  test(`staged engine-paths finds pi-coding-agent in the ${layout} layout`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `rubato-engine-paths-${layout}-`)));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const codingAgent = join(root, "node_modules/@earendil-works/pi-coding-agent");
    const piAi = layout === "nested"
      ? join(codingAgent, "node_modules/@earendil-works/pi-ai")
      : join(root, "node_modules/@earendil-works/pi-ai");
    plant(piAi, codingAgent);
    const paths = await import(pathToFileURL(join(piAi, stagedRel)).href);
    assert.equal(paths.piAiRoot, piAi);
    assert.equal(paths.senpiDir, codingAgent);
  });
}
