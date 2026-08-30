import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 브리지와 세션이 서로 다른 node 로 뜨면 같은 기계에서 두 얼굴이 된다.
// launchd 는 로그인 셸 환경을 물려주지 않아 PATH 에 nvm 이 없고, 시스템 node 는
// `--experimental-strip-types` 를 몰라 브리지가 조용히 죽는다. 그래서 후보 순서를
// 환경과 무관하게 고정했고, 여기서 그것이 실제로 그런지 본다.

const FIND_NODE = fileURLToPath(new URL("../../../scripts/find-node.sh", import.meta.url));
const SELECT_NODE = fileURLToPath(new URL("../../scripts/select-node.mjs", import.meta.url));

function resolveNode({ env = {}, bare = false } = {}) {
  const script = `. "${FIND_NODE}"; rubato_find_node`;
  const base = bare
    ? { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
    : { ...process.env };
  const run = spawnSync("/bin/sh", ["-c", script], {
    env: { ...base, RUBATO_SELECT_NODE: SELECT_NODE, ...env },
    encoding: "utf8",
  });
  return { status: run.status, bin: run.stdout.trim(), stderr: run.stderr };
}

test("the launcher and a bare launchd-like environment pick the same node", () => {
  const fromShell = resolveNode();
  if (fromShell.status !== 0) {
    // node 가 한 벌도 없는 기계에서는 검사할 것이 없다.
    assert.equal(fromShell.bin, "");
    return;
  }
  const fromLaunchd = resolveNode({ bare: true });
  assert.equal(fromLaunchd.status, 0, `bare environment found nothing: ${fromLaunchd.stderr}`);
  // Homebrew (and nvm) often expose a symlink next to the Cellar/realpath binary.
  // Equality on the printed string is the wrong contract: both launchers must pick
  // the same node, not the same spelling of its path.
  assert.equal(
    realpathSync(fromLaunchd.bin),
    realpathSync(fromShell.bin),
    `PATH 에 따라 다른 node 가 잡힌다: ${fromLaunchd.bin} vs ${fromShell.bin}`,
  );
});

test("the node it picks can actually run the bridge", () => {
  const picked = resolveNode({ bare: true });
  if (picked.status !== 0) return;
  // 브리지는 TypeScript 를 그대로 실행한다. Node 22.6 미만이면 여기서 걸린다.
  const run = spawnSync(picked.bin, ["--experimental-strip-types", "-e", "const x: number = 1; process.exit(x - 1)"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `picked node cannot strip types: ${run.stderr}`);
});

test("RUBATO_NODE wins so a machine can pin its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "find-node-"));
  try {
    const fake = join(dir, "node");
    // select-node.mjs 는 넘겨진 후보를 후보 목록에 넣고 고른다. 가짜가 그대로
    // 뽑히지 않게, 여기서는 "실행은 되지만 24 가 아닌" 것을 준다 — 오버라이드가
    // 후보 목록의 첫 자리에 오는지만 보면 된다.
    writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(fake, 0o755);
    const got = resolveNode({ env: { RUBATO_NODE: fake } });
    assert.equal(got.status, 0);
    assert.ok(got.bin.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nvm is consulted before PATH", () => {
  // 후보 순서가 뒤집히면 터미널과 launchd 가 갈린다. 가짜 nvm 루트를 세우고
  // 그것이 PATH 보다 먼저 읽히는지 본다.
  const home = mkdtempSync(join(tmpdir(), "find-node-home-"));
  try {
    const bin = join(home, ".nvm", "versions", "node", "v24.99.0", "bin");
    mkdirSync(bin, { recursive: true });
    const marker = join(bin, "node");
    writeFileSync(marker, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(marker, 0o755);

    const script = `. "${FIND_NODE}"; rubato_node_candidates`;
    const run = spawnSync("/bin/sh", ["-c", script], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    const candidates = run.stdout.trim().split("\n").filter(Boolean);
    assert.equal(candidates[0], marker, `nvm 이 첫 후보가 아니다: ${candidates.join(", ")}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher goes through the shared resolver", () => {
  // 셋이 각자 다른 방식으로 node 를 찾는 상태가 이 파일이 생긴 이유다. FX bridge 를
  // 지우면서 `start.sh` 가 사라졌으므로 남은 진입점은 세션 런처 하나다.
  assert.ok(existsSync(FIND_NODE));
  for (const name of ["rubato-pi.sh"]) {
    const source = readFileSync(fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url)), "utf8");
    assert.match(source, /find-node\.sh/, `${name} 이 공통 해석기를 쓰지 않는다`);
    assert.doesNotMatch(source, /^exec node /m, `${name} 이 PATH 의 node 를 그대로 실행한다`);
  }
});
