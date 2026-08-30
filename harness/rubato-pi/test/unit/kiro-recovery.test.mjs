import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const setup = fileURLToPath(new URL("../../../scripts/kiro-setup.sh", import.meta.url));
const startSh = fileURLToPath(new URL("../../../scripts/start.sh", import.meta.url));

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture({ credentials = true, healthy = false, running = false, os = "Darwin", context = "orbstack", stuckDesktop = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rubato-kiro-recovery-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const kiro = join(home, ".rubato-pi", "kiro");
  mkdirSync(bin, { recursive: true });
  mkdirSync(kiro, { recursive: true });
  writeFileSync(join(kiro, "config.json"), JSON.stringify({ apiKey: "local-test-key" }));
  if (credentials) {
    writeFileSync(join(kiro, "credentials.json"), JSON.stringify([{
      authMethod: "idc",
      clientId: "client",
      refreshToken: "refresh",
    }]));
  }
  if (healthy) writeFileSync(join(root, "sidecar.ready"), "1");

  stub(bin, "uname", `echo ${os}`);
  stub(bin, "sleep", "exit 0");
  stub(bin, "open", 'printf "%s\\n" "$*" >>"$STUB_ROOT/open.log"; touch "$STUB_ROOT/docker.ready"');
  stub(bin, "systemctl", 'printf "%s\\n" "$*" >>"$STUB_ROOT/systemctl.log"; touch "$STUB_ROOT/docker.ready"');
  stub(bin, "curl", '[ -f "$STUB_ROOT/sidecar.ready" ]');
  stub(bin, "docker", [
    'printf "%s\\n" "$*" >>"$STUB_ROOT/docker.log"',
    'case "$1 $2" in',
    `  "context show") echo ${context} ;;`,
    '  "info ") [ -f "$STUB_ROOT/docker.ready" ] ;;',
    '  "container inspect") exit 0 ;;',
    '  "inspect -f") [ -f "$STUB_ROOT/container.running" ] && echo true || echo false ;;',
    '  "start kiro-rs") touch "$STUB_ROOT/container.running" "$STUB_ROOT/sidecar.ready" ;;',
    `  "desktop status") ${stuckDesktop ? "exit 0" : "exit 1"} ;;`,
    '  "desktop start") touch "$STUB_ROOT/docker.ready" ;;',
    '  "desktop restart") touch "$STUB_ROOT/docker.ready" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n"));
  if (running) writeFileSync(join(root, "container.running"), "1");

  const run = spawnSync("/bin/bash", [setup, "ensure"], {
    env: {
      HOME: home,
      KIRO_DIR: kiro,
      STUB_ROOT: root,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    encoding: "utf8",
  });
  const log = (name) => {
    try { return readFileSync(join(root, name), "utf8"); }
    catch { return ""; }
  };
  return { root, run, docker: log("docker.log"), open: log("open.log"), systemctl: log("systemctl.log") };
}

test("ensure reports setup guidance on machines without Kiro credentials", () => {
  const got = fixture({ credentials: false });
  try {
    assert.notEqual(got.run.status, 0);
    assert.match(got.run.stderr, /Kiro 자격이 없다/);
    assert.equal(got.docker, "");
    assert.equal(got.open, "");
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure leaves a healthy Kiro sidecar and Docker runtime alone", () => {
  const got = fixture({ healthy: true });
  try {
    assert.equal(got.run.status, 0, got.run.stderr);
    assert.doesNotMatch(got.docker, /context show|start kiro-rs/);
    assert.equal(got.open, "");
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure wakes the current macOS Docker runtime and restores kiro-rs", () => {
  const got = fixture();
  try {
    assert.equal(got.run.status, 0, got.run.stderr);
    assert.match(got.open, /-gja OrbStack/);
    assert.match(got.docker, /context show/);
    assert.match(got.docker, /container inspect kiro-rs/);
    assert.match(got.docker, /start kiro-rs/);
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure follows a Docker Desktop context instead of assuming OrbStack", () => {
  const got = fixture({ context: "desktop-linux" });
  try {
    assert.equal(got.run.status, 0, got.run.stderr);
    assert.match(got.docker, /desktop start --detach --timeout 30/);
    assert.doesNotMatch(got.open, /OrbStack/);
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure restarts a half-stopped Docker Desktop engine", () => {
  const got = fixture({ context: "desktop-linux", stuckDesktop: true });
  try {
    assert.equal(got.run.status, 0, got.run.stderr);
    assert.match(got.docker, /desktop restart --detach --timeout 30/);
    assert.match(got.docker, /start kiro-rs/);
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure wakes Docker Desktop's user unit on Linux", () => {
  const got = fixture({ os: "Linux" });
  try {
    assert.equal(got.run.status, 0, got.run.stderr);
    assert.match(got.systemctl, /--user start docker-desktop/);
    assert.equal(got.open, "");
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("ensure never restarts a running but temporarily unready sidecar", () => {
  const got = fixture({ running: true });
  try {
    assert.equal(got.run.status, 1);
    assert.doesNotMatch(got.docker, /start kiro-rs|restart kiro-rs/);
  } finally {
    rmSync(got.root, { recursive: true, force: true });
  }
});

test("the Rubato launcher heals credentials without waking the Kiro runtime", () => {
  const launcher = readFileSync(fileURLToPath(new URL("../../../scripts/rubato-pi.sh", import.meta.url)), "utf8");
  assert.match(launcher, /kiro-setup\.sh" heal/);
  assert.doesNotMatch(launcher, /kiro-setup\.sh" ensure/);
});

test("로그인 supervisor 진입점은 없다 — Kiro 를 깨울 자리가 없다", () => {
  assert.equal(existsSync(startSh), false);
});
