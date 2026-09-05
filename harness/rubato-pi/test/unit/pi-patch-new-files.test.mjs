import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPiPatches } from "../../../scripts/apply-pi-patches.mjs";

const content = "export const preserved = true;\n";
const postimageSha256 = createHash("sha256").update(content).digest("hex");

function fixture(t, change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-addition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codingAgentSource = join(root, "source-agent");
  const tuiSource = join(root, "source-tui");
  const repoRoot = join(root, "repo");
  const patches = join(repoRoot, "harness", "pi-patches");
  mkdirSync(patches, { recursive: true });
  for (const [dir, name] of [
    [codingAgentSource, "@earendil-works/pi-coding-agent"],
    [tuiSource, "@earendil-works/pi-tui"],
  ]) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.84.2" }));
  }
  const addition = { path: "dist/compat.js", sha256: null, postimageSha256 };
  change(addition);
  writeFileSync(join(patches, "manifest.json"), JSON.stringify({
    version: 1,
    packages: [
      {
        id: "pi-coding-agent", name: "@earendil-works/pi-coding-agent",
        version: "0.84.2", files: [addition], patches: [{ file: "addition.patch" }],
      },
      {
        id: "pi-tui", name: "@earendil-works/pi-tui",
        version: "0.84.2", files: [], patches: [],
      },
    ],
  }));
  writeFileSync(join(patches, "addition.patch"),
    `--- /dev/null\n+++ b/dist/compat.js\n@@ -0,0 +1 @@\n+${content}`);
  return {
    root, patches, sourceFile: join(codingAgentSource, "dist", "compat.js"),
    options: {
      codingAgentSource, tuiSource, repoRoot,
      stageDir: join(root, "stage"), publishDir: join(root, "publish"),
    },
  };
}

test("a verified new module is published without creating it in the source", (t) => {
  const f = fixture(t);
  const result = applyPiPatches(f.options);
  assert.equal(readFileSync(join(result.codingAgent, "dist", "compat.js"), "utf8"), content);
  assert.equal(existsSync(f.sourceFile), false);
});

test("an existing caller file is never adopted as an absent preimage", (t) => {
  const f = fixture(t);
  writeFileSync(f.sourceFile, "caller-owned");
  assert.throws(() => applyPiPatches(f.options), /expected absent source file/);
  assert.equal(readFileSync(f.sourceFile, "utf8"), "caller-owned");
  assert.equal(existsSync(f.options.stageDir), false);
  assert.equal(existsSync(f.options.publishDir), false);
});

test("a new module needs an explicit postimage hash", (t) => {
  const f = fixture(t, (entry) => { delete entry.postimageSha256; });
  assert.throws(() => applyPiPatches(f.options), /requires postimage SHA256/);
  assert.equal(existsSync(f.options.publishDir), false);
});

test("dangling caller symlinks also count as existing preimages", (t) => {
  const f = fixture(t);
  const missing = join(f.root, "caller-missing-target");
  symlinkSync(missing, f.sourceFile);
  assert.throws(() => applyPiPatches(f.options), /expected absent source file/);
  assert.equal(readlinkSync(f.sourceFile), missing);
  assert.equal(existsSync(missing), false);
});

test("new module paths cannot escape their source package", (t) => {
  const f = fixture(t, (entry) => { entry.path = "../escape.js"; });
  assert.throws(() => applyPiPatches(f.options), /escapes package root/);
  assert.equal(existsSync(f.options.stageDir), false);
});

test("a failed postimage check never publishes an added module", (t) => {
  const f = fixture(t, (entry) => { entry.postimageSha256 = "0".repeat(64); });
  assert.throws(() => applyPiPatches(f.options), /postimage digest mismatch/);
  assert.equal(existsSync(f.options.publishDir), false);
  assert.equal(existsSync(f.sourceFile), false);
});

test("an additional provider package uses the same source and postimage checks", (t) => {
  const f = fixture(t);
  const manifestPath = join(f.patches, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const providerSource = join(f.root, "source-ai");
  mkdirSync(providerSource);
  writeFileSync(join(providerSource, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-ai", version: "0.84.2",
  }));
  manifest.packages.push({
    id: "pi-ai", name: "@earendil-works/pi-ai", version: "0.84.2",
    files: [{ path: "dist/compat.js", sha256: null, postimageSha256 }],
    patches: [{ file: "addition.patch" }],
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => applyPiPatches(f.options), /missing source for pi-ai/);
  assert.equal(existsSync(f.options.stageDir), false);
  applyPiPatches({ ...f.options, packageSources: { "pi-ai": providerSource } });
  assert.equal(readFileSync(join(f.options.publishDir, "pi-ai", "dist", "compat.js"), "utf8"), content);
  assert.equal(existsSync(join(providerSource, "dist")), false);
});
