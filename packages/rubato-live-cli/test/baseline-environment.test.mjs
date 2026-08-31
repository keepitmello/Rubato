import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaselineEnvironmentStore,
  baselineEnvironment,
  environmentHash,
} from "../src/baseline-environment.mjs";

class MemoryKeyStore {
  constructor() { this.key = Buffer.alloc(32, 7); }
  get() { return this.key; }
  getOrCreate() { return this.key; }
}

test("mobile baseline excludes terminal-local state and preserves launch credentials", () => {
  const filtered = baselineEnvironment({
    PATH: "/opt/bin",
    LANG: "ko_KR.UTF-8",
    API_TOKEN: "secret",
    PWD: "/private/project",
    TERM: "xterm-256color",
    ZMX_SESSION: "rubato-parent",
    CMUX_SOCKET_PATH: "/tmp/cmux",
  });
  assert.deepEqual(filtered, {
    API_TOKEN: "secret",
    LANG: "ko_KR.UTF-8",
    PATH: "/opt/bin",
  });
  assert.equal(environmentHash(filtered), environmentHash({ ...filtered, TERM: "ignored" }));
});

test("baseline is AES-256-GCM encrypted, mode 0600, and authenticated on load", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rubato-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "launch-env.enc");
  const store = new BaselineEnvironmentStore({ path, keyStore: new MemoryKeyStore() });
  const env = { PATH: "/bin", API_TOKEN: "secret", TERM: "ignored" };
  const hash = store.save(env);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const document = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(document.algorithm, "AES-256-GCM");
  assert.equal(typeof document.nonce, "string");
  assert.equal(document.iv, undefined);
  assert.deepEqual(store.load(), { API_TOKEN: "secret", PATH: "/bin" });
  assert.equal(store.refreshIfChanged(env), false);
  assert.equal(store.refreshIfChanged({ ...env, API_TOKEN: "rotated" }), true);
  assert.deepEqual(store.load(), { API_TOKEN: "rotated", PATH: "/bin" });
});
