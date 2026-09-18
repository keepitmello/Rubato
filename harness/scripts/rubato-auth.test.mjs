import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  accountState,
  bestState,
  createCliInteraction,
  createFileCredentials,
  describeState,
  handleAuthArgs,
  main,
  printStatus,
  resolveLoginMethod,
  resolveLoginProvider,
  slotPresence,
  storeApiKey,
  writeSetupToken,
} from "./rubato-auth.mjs";
import { moveCursor, normalizeKey, renderMenu } from "./auth-menu.mjs";

/** 미리 정한 키를 차례로 내주는 읽개. TTY 없이 방향키 화면을 몰고 다닌다. */
function scriptedKeys(actions) {
  const queue = [...actions];
  return {
    next: async () => queue.shift() ?? "quit",
    suspend() {},
    resume() {},
    close() {},
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "rubato-auth-"));
}

function isolatedEnv(dir, extra = {}) {
  return {
    HOME: dir,
    RUBATO_AUTH_PATH: join(dir, "auth.json"),
    RUBATO_AUTH_POOL_STATE: join(dir, "pool.json"),
    RUBATO_CLAUDE_ACCOUNT: "sub",
    RUBATO_CLAUDE_SETUP_TOKEN_FILE: join(dir, "missing-setup-token"),
    ...extra,
  };
}

function capture() {
  let out = "";
  return {
    stdout: { write(chunk) { out += chunk; } },
    text: () => out,
  };
}

test("login aliases map to engine provider ids", () => {
  assert.deepEqual(resolveLoginProvider("xai"), { id: "xai" });
  assert.deepEqual(resolveLoginProvider("grok"), { id: "xai" });
  assert.deepEqual(resolveLoginProvider("codex"), { id: "openai-codex" });
  assert.deepEqual(resolveLoginProvider("antigravity"), { id: "google-antigravity" });
  assert.deepEqual(resolveLoginProvider("claude"), { id: "anthropic" });
  assert.deepEqual(resolveLoginProvider("anthropic"), { id: "anthropic" });
  assert.deepEqual(resolveLoginProvider("kiro"), { id: "kiro" });
  assert.deepEqual(resolveLoginProvider("opencode"), { id: "opencode" });
  assert.equal(resolveLoginProvider("nope").error, "unknown");
});

test("login methods follow each provider", () => {
  assert.deepEqual(resolveLoginMethod("anthropic"), { id: "oauth" });
  assert.deepEqual(resolveLoginMethod("anthropic", "token"), { id: "setup-token" });
  assert.deepEqual(resolveLoginMethod("anthropic", "oauth"), { id: "oauth" });
  assert.deepEqual(resolveLoginMethod("kiro"), { id: "api_key" });
  assert.deepEqual(resolveLoginMethod("xai", "key"), { id: "api_key" });
  assert.equal(resolveLoginMethod("openai-codex", "token").error, "method");
});

// 액세스 토큰 만료는 고장이 아니다. 런타임이 쓰기 직전에 갱신하므로 refresh 가
// 남아 있는 한 연결된 것이고, 갱신할 것이 없을 때만 재로그인을 말한다.
test("an expired access token with a refresh token still counts as connected", () => {
  const now = Date.now();
  assert.equal(slotPresence(undefined).ok, false);
  assert.equal(slotPresence({ access: "tok" }).state, "connected");
  assert.equal(slotPresence({ access: "tok", expires: now + 3_600_000 }).state, "connected");
  assert.equal(slotPresence({ access: "tok", expires: now - 86_400_000, refresh: "r" }).state, "connected");
  assert.equal(slotPresence({ access: "tok", expires: now - 1000 }).state, "stale");
});

// 회귀: pool 이 실제 호출에서 차단한 계정을 파일만 보고 "연결됨"으로 보여 줬다.
test("a pool block outranks a healthy-looking credential", () => {
  const slot = { access: "tok", refresh: "r", expires: Date.now() + 86_400_000 };
  assert.equal(accountState(slot, { source: "login" }), "connected");
  assert.equal(accountState(slot, { source: "login", blocked: true }), "blocked");
  assert.equal(bestState(["blocked", "connected"]), "connected");
  assert.equal(bestState(["blocked", "absent"]), "blocked");
  assert.equal(describeState("blocked"), "차단됨 · 재로그인 필요");
});

test("status lists every admitted provider and login hints", async () => {
  const dir = tempHome();
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    xai: { type: "oauth", access: "a", refresh: "r" },
    "openai-codex": {
      type: "oauth",
      access: "a",
      refresh: "r",
      accounts: [
        { name: "default", source: "login", access: "a", refresh: "r", expires: 0 },
        { name: "login-2", source: "login", access: "b", refresh: "r", expires: 0 },
      ],
    },
  }));
  const { stdout, text } = capture();
  await printStatus({
    stdout,
    env: isolatedEnv(dir, { RUBATO_AUTH_PATH: authPath }),
    home: dir,
  });
  const out = text();
  assert.match(out, /xAI/);
  assert.match(out, /Codex/);
  assert.match(out, /login-2/);
  assert.match(out, /Anthropic/);
  assert.match(out, /Kiro/);
  assert.match(out, /OpenCode/);
  assert.match(out, /rubato auth login anthropic oauth/);
  assert.match(out, /rubato auth login anthropic token/);
  assert.doesNotMatch(out, /senpi \/login/);
});

test("auth_url notification opens the browser with the URL", async () => {
  const opened = [];
  let out = "";
  const interaction = await createCliInteraction({
    stdout: { write(chunk) { out += chunk; } },
    stdin: new PassThrough(),
    openUrl: (url) => opened.push(url),
  });
  interaction.notify({ type: "auth_url", url: "https://example.test/oauth", instructions: "Continue in the browser" });
  assert.deepEqual(opened, ["https://example.test/oauth"]);
  assert.match(out, /https:\/\/example\.test\/oauth/);
});

test("writeSetupToken keeps the token out of auth.json", () => {
  const dir = tempHome();
  const env = { HOME: dir, RUBATO_CLAUDE_ACCOUNT: "work" };
  const path = writeSetupToken("sk-ant-oat-test-token", { env, home: dir });
  assert.match(path, /setup-token-work$/);
  assert.equal(readFileSync(path, "utf8").trim(), "sk-ant-oat-test-token");
  assert.equal(existsOrMissing(join(dir, "auth.json")), false);
});

test("storeApiKey appends another stored account", async () => {
  const dir = tempHome();
  const authPath = join(dir, "auth.json");
  const credentials = createFileCredentials(authPath);
  await storeApiKey(credentials, "kiro", "first-key");
  await storeApiKey(credentials, "kiro", "second-key");
  const stored = await credentials.read("kiro");
  assert.equal(stored.accounts.length, 2);
  assert.equal(stored.accounts[1].key, "second-key");
});

test("login anthropic oauth and token go through the same command", async () => {
  const calls = [];
  const dir = tempHome();
  const ctx = {
    ...capture(),
    env: { HOME: dir, RUBATO_AUTH_PATH: join(dir, "auth.json") },
    home: dir,
    login: async (id, method) => { calls.push({ id, method }); },
  };
  assert.equal(await handleAuthArgs(["login", "claude"], ctx), "ok");
  assert.equal(await handleAuthArgs(["add", "anthropic", "token"], ctx), "ok");
  assert.deepEqual(calls, [
    { id: "anthropic", method: "oauth" },
    { id: "anthropic", method: "setup-token" },
  ]);
});

test("pin and remove operate on stored oauth slots", async () => {
  const dir = tempHome();
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
      accounts: [
        { name: "default", source: "login", access: "a", refresh: "r", expires: 1 },
        { name: "login-2", source: "login", access: "b", refresh: "r", expires: 1 },
      ],
    },
  }));
  const ctx = {
    ...capture(),
    env: { HOME: dir, RUBATO_AUTH_PATH: authPath, RUBATO_AUTH_POOL_STATE: join(dir, "pool.json") },
    home: dir,
  };
  assert.equal(await handleAuthArgs(["pin", "codex", "login-2"], ctx), "ok");
  assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"].pinned, "login-2");
  assert.equal(await handleAuthArgs(["remove", "codex", "login-2"], ctx), "ok");
  const after = JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"];
  assert.equal(after.accounts.length, 1);
  assert.notEqual(after.pinned, "login-2");
});

test("setup-token cannot be removed from auth.json", async () => {
  const dir = tempHome();
  const env = isolatedEnv(dir);
  const tokenPath = writeSetupToken("sk-ant-oat-keep", { env, home: dir });
  env.RUBATO_CLAUDE_SETUP_TOKEN_FILE = tokenPath;
  const ctx = { ...capture(), env, home: dir };
  assert.equal(await handleAuthArgs(["remove", "anthropic", "setup-token"], ctx), "error");
  assert.match(ctx.text(), /cannot be removed|Environment provider account/);
});

test("arrow keys alone reach a provider and start oauth", async () => {
  const dir = tempHome();
  const calls = [];
  const { stdout, text } = capture();
  await main([], {
    stdout,
    stdin: { isTTY: true },
    interactive: true,
    env: isolatedEnv(dir),
    home: dir,
    // Anthropic 까지 ↓×3, Enter 로 진입, 계정이 없으니 첫 항목이 "브라우저로 로그인".
    keys: scriptedKeys(["down", "down", "down", "enter", "enter", "quit", "quit"]),
    login: async (id, method) => { calls.push({ id, method }); },
  });
  assert.deepEqual(calls, [{ id: "anthropic", method: "oauth" }]);
  assert.match(text(), /Anthropic/);
  assert.match(text(), /브라우저로 로그인/);
});

test("number keys still jump straight to a provider", async () => {
  const dir = tempHome();
  const calls = [];
  const { stdout } = capture();
  await main([], {
    stdout,
    stdin: { isTTY: true },
    interactive: true,
    env: isolatedEnv(dir),
    home: dir,
    keys: scriptedKeys(["5", "enter", "quit", "quit"]),
    login: async (id, method) => { calls.push({ id, method }); },
  });
  assert.deepEqual(calls, [{ id: "kiro", method: "api_key" }]);
});

test("menu keys and rendering stay arrow-only", () => {
  assert.equal(normalizeKey("", { name: "up" }), "up");
  assert.equal(normalizeKey("\r", { name: "return" }), "enter");
  assert.equal(normalizeKey("", { name: "c", ctrl: true }), "quit");
  assert.equal(normalizeKey("z", { name: "z" }), undefined);
  const items = [{ label: "a", value: 1 }, { separator: true, label: "" }, { label: "b", value: 2 }];
  assert.equal(moveCursor(items, 0, 1), 2, "구분선은 건너뛴다");
  const lines = renderMenu({ title: "T", items, cursor: 2, hint: "h" });
  assert.match(lines.join("\n"), /❯/);
});

test("bare rubato auth is status-only when stdin is not a TTY", async () => {
  const dir = tempHome();
  const lines = [];
  const { stdout, text } = capture();
  await main([], {
    stdout,
    stdin: { isTTY: false },
    env: { HOME: dir, RUBATO_AUTH_PATH: join(dir, "auth.json") },
    home: dir,
    readLine: async () => {
      lines.push("read");
      return "q";
    },
  });
  assert.deepEqual(lines, []);
  assert.match(text(), /rubato auth/);
});

function existsOrMissing(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
