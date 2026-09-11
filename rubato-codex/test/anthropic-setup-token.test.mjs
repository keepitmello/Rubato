import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureOpenCodexAnthropicAuth,
  readClaudeSetupToken,
  SETUP_TOKEN_LIFETIME_MS,
} from "../scripts/anthropic-setup-token.mjs";

const SETUP = { command: "/managed/ocx", selectedProviders: ["anthropic", "cursor"] };
const TOKEN = "sk-ant-oat01-testtokenvaluethatislongenough";

async function home() {
  return mkdtemp(join(tmpdir(), "rubato-anthropic-"));
}

test("a setup-token file is read with its mtime as the issue date", async () => {
  const root = await home();
  await mkdir(join(root, ".claude", "auth"), { recursive: true });
  const path = join(root, ".claude", "auth", "setup-token-sub");
  await writeFile(path, `${TOKEN}\n`);
  const found = await readClaudeSetupToken({ env: {}, home: root });
  assert.equal(found.token, TOKEN);
  assert.equal(found.source, "file");
  assert.equal(found.issuedAt, (await stat(path)).mtimeMs);
});

test("a value without the setup-token prefix is not a setup-token", async () => {
  const root = await home();
  await mkdir(join(root, ".claude", "auth"), { recursive: true });
  await writeFile(join(root, ".claude", "auth", "setup-token-sub"), "sk-ant-api03-not-a-setup-token\n");
  // Falls through to the Keychain, which this platform-independent test never populates.
  const found = await readClaudeSetupToken({ env: {}, home: root });
  assert.equal(found, undefined);
});

test("import writes an oauth account the anthropic adapter can use", async () => {
  const opencodexHome = await home();
  const issuedAt = 1_700_000_000_000;
  const result = await configureOpenCodexAnthropicAuth(SETUP, {
    opencodexHome,
    now: () => 1_800_000_000_000,
    accountId: () => "abc123",
    readToken: async () => ({ token: TOKEN, source: "file", issuedAt }),
  });
  assert.equal(result.status, "imported");
  const store = JSON.parse(await readFile(join(opencodexHome, "auth.json"), "utf8"));
  const account = store.anthropic.accounts[0];
  assert.equal(store.anthropic.activeAccountId, "abc123");
  // The token goes in `access`, not as an api key: authMode oauth is the path that sends
  // `Authorization: Bearer` plus the Claude Code beta header.
  assert.equal(account.credential.access, TOKEN);
  assert.equal(account.credential.source, "oauth");
  assert.equal(account.credential.refresh, "");
  assert.equal(account.credential.accountId, "abc123", "identity falls back to refresh when accountId is absent");
  assert.equal(account.credential.expires, issuedAt + SETUP_TOKEN_LIFETIME_MS);
  assert.equal((await stat(join(opencodexHome, "auth.json"))).mode & 0o777, 0o600);
});

test("an existing anthropic login is never replaced", async () => {
  const opencodexHome = await home();
  const existing = { anthropic: { activeAccountId: "kept", accounts: [{ id: "kept" }] } };
  await writeFile(join(opencodexHome, "auth.json"), JSON.stringify(existing));
  const result = await configureOpenCodexAnthropicAuth(SETUP, {
    opencodexHome,
    readToken: async () => assert.fail("must not read a token when a login already exists"),
  });
  assert.equal(result.status, "existing-login-preserved");
  assert.deepEqual(JSON.parse(await readFile(join(opencodexHome, "auth.json"), "utf8")), existing);
});

test("other providers' credentials survive the import", async () => {
  const opencodexHome = await home();
  const others = { cursor: { activeAccountId: "c1", accounts: [{ id: "c1" }] } };
  await writeFile(join(opencodexHome, "auth.json"), JSON.stringify(others));
  await configureOpenCodexAnthropicAuth(SETUP, {
    opencodexHome,
    accountId: () => "abc123",
    readToken: async () => ({ token: TOKEN, source: "keychain", issuedAt: 1 }),
  });
  const store = JSON.parse(await readFile(join(opencodexHome, "auth.json"), "utf8"));
  assert.deepEqual(store.cursor, others.cursor);
  assert.ok(store.anthropic);
});

test("an unparseable store is left alone", async () => {
  const opencodexHome = await home();
  await writeFile(join(opencodexHome, "auth.json"), "{ not json");
  const result = await configureOpenCodexAnthropicAuth(SETUP, {
    opencodexHome,
    readToken: async () => ({ token: TOKEN, source: "file", issuedAt: 1 }),
  });
  assert.equal(result.status, "unreadable-store");
  assert.equal(await readFile(join(opencodexHome, "auth.json"), "utf8"), "{ not json");
});

test("no token and no anthropic selection are ordinary outcomes, not failures", async () => {
  const opencodexHome = await home();
  const missing = await configureOpenCodexAnthropicAuth(SETUP, { opencodexHome, readToken: async () => undefined });
  assert.equal(missing.status, "no-local-token");
  assert.equal(missing.nextStep, "/managed/ocx login anthropic");

  const notSelected = await configureOpenCodexAnthropicAuth(
    { command: "/managed/ocx", selectedProviders: ["cursor"] },
    { opencodexHome, readToken: async () => assert.fail("must not read a token for an unselected provider") },
  );
  assert.equal(notSelected.status, "not-selected");

  const planned = await configureOpenCodexAnthropicAuth(SETUP, {
    opencodexHome,
    dryRun: true,
    readToken: async () => ({ token: TOKEN, source: "file", issuedAt: 1 }),
  });
  assert.equal(planned.status, "planned");
  assert.equal(await readFile(join(opencodexHome, "auth.json"), "utf8").catch(() => null), null, "dry run writes nothing");
});
