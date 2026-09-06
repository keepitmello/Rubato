#!/usr/bin/env node
// Read-only preflight. Never applies a patch or overwrites local work.
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha256 = b => createHash("sha256").update(b).digest("hex");
const gitBlob = b => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
function inside(root, path) {
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || isAbsolute(path) || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`안전하지 않은 상대 경로예요: ${path}`);
  return full;
}
export function verifyPackage(packageRoot, targetRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "PATCH_MANIFEST.json"), "utf8"));
  const rows = [];
  for (const file of manifest.files) {
    const from = inside(packageRoot, file.path);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`압축 파일 안의 링크는 허용하지 않아요: ${file.path}`);
    const body = readFileSync(from);
    if (sha256(body) !== file.sha256) throw new Error(`전달 파일의 해시가 맞지 않아요: ${file.path}`);
    if (!targetRoot) { rows.push({ path: file.path, status: "package-valid" }); continue; }
    const dest = inside(targetRoot, file.path);
    if (!existsSync(dest)) { rows.push({ path: file.path, status: file.originalGitBlobSha ? "missing-original" : "can-add" }); continue; }
    if (lstatSync(dest).isSymbolicLink()) { rows.push({ path: file.path, status: "merge-required-symlink" }); continue; }
    const current = readFileSync(dest), hash = sha256(current);
    const status = hash === file.sha256 ? "already-current"
      : hash === file.previousPackageSha256 ? "can-upgrade-v1"
      : file.originalGitBlobSha && gitBlob(current) === file.originalGitBlobSha ? "can-update-original"
      : "merge-required";
    rows.push({ path: file.path, status });
  }
  return { baseCommit: manifest.baseCommit, readOnly: true, files: rows,
    needsMerge: rows.some(r => r.status.startsWith("merge-required") || r.status === "missing-original") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error("사용법: node verify-context-notes-package.mjs [TARGET_REPOSITORY]");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = verifyPackage(root, process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(JSON.stringify(result, null, 2));
    if (result.needsMerge) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
