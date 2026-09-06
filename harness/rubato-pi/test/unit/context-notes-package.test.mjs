import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyPackage } from "../../scripts/verify-context-notes-package.mjs";
const digest = b => createHash("sha256").update(b).digest("hex");
function fixture(t, dest) {
  const root = mkdtempSync(join(tmpdir(), "notes-package-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "pkg"), target = join(root, "target"); mkdirSync(pkg); mkdirSync(target);
  const file = { path: "example.mjs", sha256: digest("v2"), previousPackageSha256: digest("v1"), originalGitBlobSha: null };
  writeFileSync(join(pkg, "example.mjs"), "v2");
  writeFileSync(join(pkg, "PATCH_MANIFEST.json"), JSON.stringify({ files: [file] }));
  if (dest !== undefined) writeFileSync(join(target, "example.mjs"), dest);
  return { pkg, target };
}
test("preflight recognizes previous package without overwriting it", t => {
  const f = fixture(t, "v1"); const r = verifyPackage(f.pkg, f.target);
  assert.equal(r.files[0].status, "can-upgrade-v1"); assert.equal(r.needsMerge, false);
});
test("preflight preserves user's divergent edits by requiring merge", t => {
  const f = fixture(t, "my edits"); const r = verifyPackage(f.pkg, f.target);
  assert.equal(r.files[0].status, "merge-required"); assert.equal(r.needsMerge, true);
});
test("preflight detects corrupt payload bytes", t => {
  const f = fixture(t); writeFileSync(join(f.pkg, "example.mjs"), "wrong");
  assert.throws(() => verifyPackage(f.pkg, f.target), /해시/);
});
test("preflight detects current and absent new files", t => {
  const f = fixture(t); assert.equal(verifyPackage(f.pkg, f.target).files[0].status, "can-add");
  writeFileSync(join(f.target, "example.mjs"), "v2");
  assert.equal(verifyPackage(f.pkg, f.target).files[0].status, "already-current");
});
