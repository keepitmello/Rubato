import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const pristinePackage =
  process.env.PI_SESSION_CATALOG_TEST_PACKAGE ??
  resolvePiRuntime({ root: runtimeRoot }).codingAgentDir;
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-pi-session-catalog-"));
const patchedPackage = join(scratchRoot, "pi-coding-agent");

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function withoutNodeOptions(env) {
  const copy = { ...env };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function preparePatchedPackage() {
  mkdirSync(patchedPackage, { recursive: true });
  cpSync(join(pristinePackage, "dist"), join(patchedPackage, "dist"), { recursive: true });
  copyFileSync(join(pristinePackage, "package.json"), join(patchedPackage, "package.json"));
  symlinkSync(join(pristinePackage, "node_modules"), join(patchedPackage, "node_modules"), "dir");
  for (const file of files) {
    const target = join(patchedPackage, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourcePath, target);
  }
  for (const spec of patches) {
    const target = join(patchedPackage, spec.path);
    const pristine = readFileSync(target, "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256, `${spec.path} pristine hash`);
    writeFileSync(target, spec.apply(pristine));
  }
}

function userMessage(text, timestamp = Date.now()) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function sessionJsonl({ id, cwd, text, timestamp }) {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      cwd,
      timestamp: new Date(timestamp).toISOString(),
    }),
    JSON.stringify({
      type: "message",
      id: `entry-${id}`,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: userMessage(text, timestamp),
    }),
  ].join("\n") + "\n";
}

preparePatchedPackage();

test("manifest is stock-version locked, additive, drift-strict, and valid JavaScript", () => {
  assert.equal(patches.length, 2);
  assert.deepEqual(files.map((file) => file.path), [
    "dist/rubato-features/session-catalog/catalog.mjs",
  ]);
  assert.equal(new Set(patches.map((spec) => spec.id)).size, patches.length);

  for (const spec of patches) {
    assert.equal(spec.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(spec.version, "0.85.1");
    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    const output = readFileSync(join(patchedPackage, spec.path), "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256);
    assert.notEqual(output, pristine);
    assert.throws(() => spec.apply(output), /expected anchor is missing/);
  }

  for (const path of ["dist/core/session-manager.js", ...files.map((file) => file.path)]) {
    const syntax = spawnSync(process.execPath, ["--check", join(patchedPackage, path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("actual SessionManager persists the first user turn and survives restart and fork", async () => {
  const moduleUrl = pathToFileURL(join(patchedPackage, "dist/index.js")).href;
  const { SessionManager } = await import(moduleUrl);
  const cwd = join(scratchRoot, "first-user-cwd");
  const sessionDir = join(scratchRoot, "first-user-sessions");
  const forkCwd = join(scratchRoot, "fork-cwd");
  const forkDir = join(scratchRoot, "fork-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(forkCwd, { recursive: true });
  mkdirSync(forkDir, { recursive: true });

  const manager = SessionManager.create(cwd, sessionDir, { id: "first-user" });
  const sessionFile = manager.getSessionFile();
  assert.equal(existsSync(sessionFile), false, "an untouched session stays ephemeral");
  manager.appendModelChange("offline", "fake-model");
  assert.equal(existsSync(sessionFile), false, "metadata alone does not create a session file");
  const userEntryId = manager.appendMessage(userMessage("persist before provider"));
  assert.equal(existsSync(sessionFile), true, "the first user append flushes the file");

  const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "session");
  assert.equal(lines.at(-1).id, userEntryId);
  assert.equal(lines.at(-1).message.content[0].text, "persist before provider");

  const restartScript = `
const { SessionManager } = await import(process.argv[1]);
const session = SessionManager.open(process.argv[2]);
const messages = session.getEntries().filter((entry) => entry.type === "message");
process.stdout.write(JSON.stringify({
  id: session.getSessionId(),
  cwd: session.getCwd(),
  texts: messages.map((entry) => entry.message.content[0].text),
}));
`;
  const restarted = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", restartScript, moduleUrl, sessionFile],
    { encoding: "utf8", env: withoutNodeOptions(process.env) },
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), {
    id: "first-user",
    cwd,
    texts: ["persist before provider"],
  });

  const forked = SessionManager.forkFrom(sessionFile, forkCwd, forkDir, { id: "forked-first-user" });
  assert.equal(existsSync(forked.getSessionFile()), true);
  assert.equal(forked.getHeader().parentSession, sessionFile);
  assert.deepEqual(
    forked.getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message.content[0].text),
    ["persist before provider"],
  );
});

test("actual paged catalog is stable and only fully parses a normal result page", async () => {
  const moduleUrl = pathToFileURL(join(patchedPackage, "dist/index.js")).href;
  const { SessionManager } = await import(moduleUrl);
  const cwd = join(scratchRoot, "catalog-cwd");
  const otherCwd = join(scratchRoot, "other-cwd");
  const sessionDir = join(scratchRoot, "catalog-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(otherCwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const base = Date.now() - 300_000;
  for (let index = 0; index < 120; index += 1) {
    const id = `session-${String(index).padStart(3, "0")}`;
    const timestamp = base + index * 1_000;
    const path = join(sessionDir, `${id}.jsonl`);
    writeFileSync(path, sessionJsonl({
      id,
      cwd,
      text: index === 3 ? "needle-only-in-an-old-session" : `message-${index}`,
      timestamp,
    }));
    const fileSeconds = (index >= 118 ? base + 119_000 : timestamp) / 1_000;
    utimesSync(path, fileSeconds, fileSeconds);
  }
  writeFileSync(
    join(sessionDir, "other-project.jsonl"),
    sessionJsonl({ id: "other-project", cwd: otherCwd, text: "not in current scope", timestamp: base + 500_000 }),
  );
  writeFileSync(join(sessionDir, "malformed.jsonl"), "{not-json}\n");

  const firstProgress = [];
  const first = await SessionManager.listPage(
    cwd,
    sessionDir,
    (loaded, total) => firstProgress.push([loaded, total]),
    { offset: 0, limit: 12 },
  );
  assert.equal(first.total, 120);
  assert.equal(first.sessions.length, 12);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.sessions.map((session) => session.id), [
    "session-118",
    "session-119",
    "session-117",
    "session-116",
    "session-115",
    "session-114",
    "session-113",
    "session-112",
    "session-111",
    "session-110",
    "session-109",
    "session-108",
  ]);
  assert.equal(firstProgress.length, 12, "normal paging fully parses only the selected page");
  assert.deepEqual(firstProgress.at(-1), [12, 120]);

  const secondProgress = [];
  const second = await SessionManager.listPage(
    cwd,
    sessionDir,
    (loaded, total) => secondProgress.push([loaded, total]),
    { offset: 12, limit: 12 },
  );
  assert.equal(second.sessions.length, 12);
  assert.equal(second.sessions[0].id, "session-107");
  assert.equal(new Set([...first.sessions, ...second.sessions].map((session) => session.id)).size, 24);
  assert.deepEqual(secondProgress.at(-1), [24, 120]);

  const searchProgress = [];
  const search = await SessionManager.listPage(
    cwd,
    sessionDir,
    (loaded, total) => searchProgress.push([loaded, total]),
    { offset: 0, limit: 5, query: "NEEDLE-ONLY" },
  );
  assert.equal(search.total, 1);
  assert.equal(search.hasMore, false);
  assert.deepEqual(search.sessions.map((session) => session.id), ["session-003"]);
  assert.equal(searchProgress.length, 120, "unindexed message search deliberately scans the scope");
  assert.deepEqual(searchProgress.at(-1), [120, 120]);

  const all = await SessionManager.listAllPage(sessionDir, undefined, { offset: 0, limit: 3 });
  assert.equal(all.total, 121, "listAllPage includes the valid session from the other cwd");
  assert.deepEqual(all.sessions.map((session) => session.id), [
    "other-project",
    "session-118",
    "session-119",
  ]);
});
