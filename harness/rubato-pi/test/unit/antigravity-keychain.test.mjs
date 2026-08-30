import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANTIGRAVITY_PROVIDER_ID,
  antigravityCredentialFromKeychain,
  antigravityCredentialPresent,
  decodeAntigravityKeychainSecret,
  importAntigravityKeychainCredential,
  readAntigravityKeychainSecret,
  readStoredAntigravityCredential,
} from "../../src/antigravity-keychain-import.mjs";

function encodedSecret({ access = "access-test", refresh = "refresh-test", expiry = "2099-01-01T00:00:00Z" } = {}) {
  const json = JSON.stringify({ token: { access_token: access, refresh_token: refresh, expiry } });
  return `go-keyring-base64:${Buffer.from(json).toString("base64")}`;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (...args) => child.killCalls.push(args);
  return child;
}

test("Keychain decode와 canonical OAuth credential이 project env를 쓴다", () => {
  const token = decodeAntigravityKeychainSecret(encodedSecret());
  assert.deepEqual(token, { access: "access-test", refresh: "refresh-test", expiry: "2099-01-01T00:00:00Z" });
  const credential = antigravityCredentialFromKeychain(token, { projectId: "project-a" });
  assert.equal(credential.type, "oauth");
  assert.equal(credential.env.RUBATO_ANTIGRAVITY_PROJECT, "project-a");
});

test("Keychain lookup은 abort/error/close 경쟁에서 한 번만 정착하고 late child를 죽인다", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const work = readAntigravityKeychainSecret({
    signal: controller.signal,
    spawnImpl: (_command, _args, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      return child;
    },
  });
  await assert.rejects(work, (error) => error.name === "AbortError");
  assert.equal(child.killCalls.length, 1, "동기 abort 뒤 반환된 child가 남았다");
  child.emit("error", new Error("late error"));
  child.emit("close", 0);
});

class FakeReadOnlyAuthStorage {
  constructor(path) { this.path = path; }
  load() { return {}; }
}

class FakeBackend {
  static current = "{}";
  static next;
  async withLockAsync(fn) {
    const outcome = await fn(FakeBackend.current);
    if (outcome?.next !== undefined) FakeBackend.next = outcome.next;
    return outcome?.result;
  }
}

test("import는 target lock 안에서 no-overwrite하고 두 번째 호출은 skip한다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-antigravity-keychain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetPath = join(dir, "auth.json");
  FakeBackend.current = "{}";
  FakeBackend.next = undefined;

  const child = fakeChild();
  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(encodedSecret()));
      child.emit("close", 0);
    });
    return child;
  };
  const result = await importAntigravityKeychainCredential({
    enabled: true,
    targetPath,
    read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    spawnImpl,
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
    projectId: "project-a",
  });
  assert.equal(result.status, "imported");
  const imported = JSON.parse(FakeBackend.next);
  assert.equal(imported[ANTIGRAVITY_PROVIDER_ID].env.RUBATO_ANTIGRAVITY_PROJECT, "project-a");

  FakeBackend.current = JSON.stringify({
    [ANTIGRAVITY_PROVIDER_ID]: { type: "oauth", access: "winner", refresh: "winner", expires: 1 },
  });
  const raced = await importAntigravityKeychainCredential({
    enabled: true,
    targetPath,
    read: () => "{}",
    spawnImpl,
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
    projectId: "project-a",
  });
  assert.equal(raced.status, "skipped");
  assert.match(FakeBackend.current, /winner/);
});

test("project 조회가 실패하면 expires=0으로 저장하고 거절하지 않는다", async () => {
  FakeBackend.current = "{}";
  FakeBackend.next = undefined;
  const child = fakeChild();
  const result = await importAntigravityKeychainCredential({
    enabled: true,
    targetPath: "/tmp/rubato-antigravity-expired-access-test.json",
    read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(encodedSecret()));
        child.emit("close", 0);
      });
      return child;
    },
    resolveProjectId: async () => {
      throw new Error("Antigravity loadCodeAssist failed (401)");
    },
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
  });
  assert.equal(result.status, "imported");
  const imported = JSON.parse(FakeBackend.next)[ANTIGRAVITY_PROVIDER_ID];
  assert.equal(imported.expires, 0);
  assert.equal(imported.env, undefined);
});

test("project env가 없으면 import 전에 project를 발견해 credential에 고정한다", async () => {
  FakeBackend.current = "{}";
  FakeBackend.next = undefined;
  const child = fakeChild();
  let seenAccess;
  const result = await importAntigravityKeychainCredential({
    enabled: true,
    targetPath: "/tmp/rubato-antigravity-project-test.json",
    read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(encodedSecret()));
        child.emit("close", 0);
      });
      return child;
    },
    resolveProjectId: async (token) => {
      seenAccess = token.access;
      return "discovered-project";
    },
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
  });
  assert.equal(result.status, "imported");
  assert.equal(seenAccess, "access-test");
  assert.equal(JSON.parse(FakeBackend.next)[ANTIGRAVITY_PROVIDER_ID].env.RUBATO_ANTIGRAVITY_PROJECT, "discovered-project");
});

test("lock 안의 broker sentinel은 Keychain 자격으로 교체한다", async () => {
  const sentinel = {
    type: "oauth",
    access: "local",
    refresh: "rubato-broker",
    expires: 1,
  };
  FakeBackend.current = JSON.stringify({ [ANTIGRAVITY_PROVIDER_ID]: sentinel });
  FakeBackend.next = undefined;
  const child = fakeChild();
  const result = await importAntigravityKeychainCredential({
    enabled: true,
    targetPath: "/tmp/rubato-antigravity-sentinel-replace-test.json",
    read: () => FakeBackend.current,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(encodedSecret({ access: "from-keychain", refresh: "from-keychain" })));
        child.emit("close", 0);
      });
      return child;
    },
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
    projectId: "project-a",
  });
  assert.equal(result.status, "imported");
  const imported = JSON.parse(FakeBackend.next)[ANTIGRAVITY_PROVIDER_ID];
  assert.equal(imported.access, "from-keychain");
  assert.equal(imported.refresh, "from-keychain");
  assert.notEqual(imported.refresh, "rubato-broker");
});

test("broker sentinel은 있는 자격이 아니다", () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-antigravity-sentinel-"));
  const targetPath = join(dir, "auth.json");
  writeFileSync(targetPath, `${JSON.stringify({
    [ANTIGRAVITY_PROVIDER_ID]: { type: "oauth", access: "local", refresh: "rubato-broker", expires: 1 },
  })}\n`);
  try {
    assert.equal(antigravityCredentialPresent(targetPath, { ReadOnlyAuthStorage: FakeReadOnlyAuthStorage }), false);
    assert.equal(readStoredAntigravityCredential(targetPath), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import는 abort를 keychain_unavailable로 삼키지 않는다", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const work = importAntigravityKeychainCredential({
    enabled: true,
    targetPath: "/tmp/not-read",
    read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    spawnImpl: () => {
      queueMicrotask(() => controller.abort());
      return child;
    },
    signal: controller.signal,
    backendFactory: FakeBackend,
    ReadOnlyAuthStorage: FakeReadOnlyAuthStorage,
  });
  await assert.rejects(work, (error) => error.name === "AbortError");
});
