import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPiPatches, ApplyPiPatchesError } from "../../../scripts/apply-pi-patches.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const CA_FIXTURE = "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const TUI_FIXTURE = "/tmp/pi-tui-scratch/package";
const MANIFEST = JSON.parse(readFileSync(join(repoRoot, "harness", "pi-patches", "manifest.json"), "utf8"));

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureProblem() {
  if (!existsSync(join(CA_FIXTURE, "package.json"))) return `coding-agent fixture missing: ${CA_FIXTURE}`;
  if (!existsSync(join(TUI_FIXTURE, "package.json"))) return `tui fixture missing: ${TUI_FIXTURE}`;
  const ca = JSON.parse(readFileSync(join(CA_FIXTURE, "package.json"), "utf8"));
  const tui = JSON.parse(readFileSync(join(TUI_FIXTURE, "package.json"), "utf8"));
  if (ca.name !== "@earendil-works/pi-coding-agent" || ca.version !== "0.84.2") {
    return `coding-agent is ${ca.name}@${ca.version}`;
  }
  if (tui.name !== "@earendil-works/pi-tui" || tui.version !== "0.84.2") {
    return `tui is ${tui.name}@${tui.version}`;
  }
  return null;
}

const SKIP = fixtureProblem();

function snapshotSources() {
  const files = [];
  for (const spec of MANIFEST.packages) {
    const root = spec.id === "pi-coding-agent" ? CA_FIXTURE
      : spec.id === "pi-tui" ? TUI_FIXTURE
      : join(CA_FIXTURE, "node_modules", "@earendil-works", spec.id);
    for (const file of spec.files) {
      files.push({ path: join(root, file.path), sha: file.sha256 === null ? null : sha256File(join(root, file.path)) });
    }
  }
  return files;
}

function assertSourcesUnchanged(before) {
  for (const entry of before) {
    if (entry.sha === null) {
      assert.equal(existsSync(entry.path), false, `source created: ${entry.path}`);
      continue;
    }
    assert.equal(sha256File(entry.path), entry.sha, `source mutated: ${entry.path}`);
  }
}

function copyListed(spec, sourceRoot, destRoot) {
  mkdirSync(destRoot, { recursive: true });
  for (const file of spec.files) {
    if (file.sha256 === null) continue;
    const dest = join(destRoot, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(sourceRoot, file.path), dest);
  }
}

function scratchPair() {
  const root = mkdtempSync(join(tmpdir(), "pi-apply-"));
  return {
    root,
    stage: join(root, "stage"),
    publish: join(root, "publish"),
    caCopy: join(root, "ca-src"),
    tuiCopy: join(root, "tui-src"),
  };
}

function seedSources(pair) {
  const byId = Object.fromEntries(MANIFEST.packages.map((pkg) => [pkg.id, pkg]));
  copyListed(byId["pi-coding-agent"], CA_FIXTURE, pair.caCopy);
  copyListed(byId["pi-tui"], TUI_FIXTURE, pair.tuiCopy);
  for (const spec of MANIFEST.packages.slice(2)) {
    copyListed(spec, join(CA_FIXTURE, "node_modules", "@earendil-works", spec.id),
      join(pair.caCopy, "node_modules", "@earendil-works", spec.id));
  }
}

test("manifest order is reload-guard then reload-ui, then unicode on tui", { skip: SKIP ?? undefined }, () => {
  const [coding, tui] = MANIFEST.packages;
  assert.equal(coding.id, "pi-coding-agent");
  assert.deepEqual(coding.patches.slice(0, 2).map((p) => p.id), ["reload-guard", "reload-ui"]);
  assert.equal(tui.id, "pi-tui");
  assert.equal(tui.patches[0].id, "unicode-input");
  assert.deepEqual(MANIFEST.packages.map((p) => p.id),
    ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"]);
});

test("applies the integrated patch set on copied stock inputs and matches every postimage", { skip: SKIP ?? undefined }, () => {
  const before = snapshotSources();
  const pair = scratchPair();
  seedSources(pair);
  const result = applyPiPatches({
    codingAgentSource: pair.caCopy,
    tuiSource: pair.tuiCopy,
    stageDir: pair.stage,
    publishDir: pair.publish,
    repoRoot,
  });
  assertSourcesUnchanged(before);
  assert.equal(sha256File(join(pair.caCopy, "dist/core/agent-session.js")), before.find((e) => e.path.endsWith("agent-session.js")).sha);
  for (const spec of MANIFEST.packages) {
    for (const file of spec.files) {
      const want = file.postimageSha256 ?? file.sha256;
      assert.equal(sha256File(join(pair.publish, spec.id, file.path)), want, spec.id + ":" + file.path);
    }
  }
  const session = readFileSync(join(result.codingAgent, "dist/core/agent-session.js"), "utf8");
  const interactive = readFileSync(join(result.codingAgent, "dist/modes/interactive/interactive-mode.js"), "utf8");
  const stdin = readFileSync(join(result.tui, "dist/stdin-buffer.js"), "utf8");
  assert.match(session, /checkReloadVeto/);
  assert.match(interactive, /checkReloadVeto/);
  assert.match(interactive, /editorContainer\.addChild\(reloadBox\)/);
  assert.match(stdin, /StringDecoder/);
});

test("digest drift is rejected before publish and leaves sources untouched", { skip: SKIP ?? undefined }, () => {
  const before = snapshotSources();
  const pair = scratchPair();
  seedSources(pair);
  const target = join(pair.caCopy, "dist/core/agent-session.js");
  const original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from("\n// drifted\n")]));
  const drifted = sha256File(target);
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: pair.publish,
      repoRoot,
    }),
    (error) => {
      assert.ok(error instanceof ApplyPiPatchesError);
      assert.match(error.message, /pristine digest mismatch/);
      return true;
    },
  );
  assert.equal(existsSync(pair.publish), false, "publish must not be created on digest failure");
  assert.equal(sha256File(target), drifted, "applicator must not patch the drifted source");
  assertSourcesUnchanged(before);
});

test("wrong package version fails before publish", { skip: SKIP ?? undefined }, () => {
  const before = snapshotSources();
  const pair = scratchPair();
  seedSources(pair);
  const pkgPath = join(pair.caCopy, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = "0.0.0-not-stock";
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: pair.publish,
      repoRoot,
    }),
    /identity mismatch/,
  );
  assert.equal(existsSync(pair.publish), false);
  assertSourcesUnchanged(before);
});

test("existing publish is not overwritten", { skip: SKIP ?? undefined }, () => {
  const pair = scratchPair();
  seedSources(pair);
  mkdirSync(pair.publish, { recursive: true });
  const sentinel = join(pair.publish, "user-state.txt");
  writeFileSync(sentinel, "keep");
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: pair.publish,
      repoRoot,
    }),
    /publish already exists/,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("repeat against a completed publish fails and leaves output intact", { skip: SKIP ?? undefined }, () => {
  const pair = scratchPair();
  seedSources(pair);
  applyPiPatches({
    codingAgentSource: pair.caCopy,
    tuiSource: pair.tuiCopy,
    stageDir: pair.stage,
    publishDir: pair.publish,
    repoRoot,
  });
  const marker = join(pair.publish, "pi-tui", "dist", "stdin-buffer.js");
  const first = sha256File(marker);
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: join(pair.root, "stage-2"),
      publishDir: pair.publish,
      repoRoot,
    }),
    /publish already exists/,
  );
  assert.equal(sha256File(marker), first);
});

test("publish path that realpaths into source is rejected", { skip: SKIP ?? undefined }, () => {
  const before = snapshotSources();
  const pair = scratchPair();
  seedSources(pair);
  const nested = join(pair.caCopy, "published-here");
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: nested,
      repoRoot,
    }),
    /inside/,
  );
  assert.equal(existsSync(nested), false);
  assertSourcesUnchanged(before);
  const session = join(pair.caCopy, "dist/core/agent-session.js");
  assert.equal(sha256File(session), MANIFEST.packages[0].files.find((f) => f.path.endsWith("agent-session.js")).sha256);
});

test("foreign publish dir created during patch is not deleted on failure", { skip: SKIP ?? undefined }, () => {
  const before = snapshotSources();
  const pair = scratchPair();
  seedSources(pair);
  const sentinel = join(pair.publish, "user-sentinel.txt");
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: pair.publish,
      repoRoot,
      beforePatch({ patchId, stagePkg }) {
        if (patchId !== "reload-ui") return;
        mkdirSync(pair.publish, { recursive: true });
        writeFileSync(sentinel, "foreign-owned");
        writeFileSync(join(stagePkg, "dist/modes/interactive/interactive-mode.js"), "broken-baseline\n");
      },
    }),
    (error) => {
      assert.ok(error instanceof ApplyPiPatchesError);
      assert.match(error.message, /patch failed|digest mismatch|not a clean/);
      return true;
    },
  );
  assert.equal(existsSync(sentinel), true, "foreign sentinel must survive applicator failure");
  assert.equal(readFileSync(sentinel, "utf8"), "foreign-owned");
  assertSourcesUnchanged(before);
});

test("stage and publish overlap is rejected", { skip: SKIP ?? undefined }, () => {
  const pair = scratchPair();
  seedSources(pair);
  assert.throws(
    () => applyPiPatches({
      codingAgentSource: pair.caCopy,
      tuiSource: pair.tuiCopy,
      stageDir: pair.stage,
      publishDir: pair.stage,
      repoRoot,
    }),
    /overlap|already exists/,
  );
  assert.equal(existsSync(pair.publish), false);
});

test("CLI applies the three patches without a controlling-tty hang", { skip: SKIP ?? undefined }, () => {
  const pair = scratchPair();
  seedSources(pair);
  const result = spawnSync(process.execPath, [
    join(repoRoot, "harness", "scripts", "apply-pi-patches.mjs"),
    "--coding-agent", pair.caCopy,
    "--tui", pair.tuiCopy,
    "--stage", pair.stage,
    "--publish", pair.publish,
  ], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(existsSync(join(out.codingAgent, "dist/core/agent-session.js")));
  assert.ok(existsSync(join(out.tui, "dist/stdin-buffer.js")));
});
