import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountModelSuffix } from "../rubato-pi/src/account-lanes.mjs";
import { CredentialSlotRepository } from "../pi-runtime/features/providers/auth-pool/state-store.mjs";
import { createFileCredentials, statusJson } from "./rubato-auth.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "rubato-account-roles-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    HOME: home, RUBATO_AUTH_PATH: join(home, "auth.json"), RUBATO_AUTH_POOL_STATE: join(home, "pool.json"),
    RUBATO_CLAUDE_SETUP_TOKEN_FILE: join(home, "setup-token"), RUBATO_CLAUDE_ACCOUNT: home,
  };
  writeFileSync(env.RUBATO_CLAUDE_SETUP_TOKEN_FILE, "sk-ant-oat-test\n");
  const credential = { type: "oauth", access: "secret", refresh: "secret-refresh", expires: Date.now() + 99_999 };
  writeFileSync(env.RUBATO_AUTH_PATH, JSON.stringify({ anthropic: credential }));
  return {
    env, credentials: createFileCredentials(env.RUBATO_AUTH_PATH),
    repository: new CredentialSlotRepository(env.RUBATO_AUTH_POOL_STATE),
    vertexKeychain: { read: async () => undefined },
  };
}

test("account roles follow the same mapping as model requests, never the internal name or pin", () => {
  const cases = [
    [[{ name: "default" }], { default: "" }],
    [[{ name: "custom-a" }, { name: "custom-b" }], { "custom-a": null, "custom-b": null }],
    [[{ name: "setup-token" }], { "setup-token": "" }],
    [[{ name: "default", pinned: true }, { name: "setup-token" }], { default: "-sub", "setup-token": "" }],
    [[{ name: "default" }, { name: "login-2" }], { default: "", "login-2": "-sub" }],
    [[{ name: "default" }, { name: "sub" }, { name: "login-2" }], { default: "", sub: "-sub", "login-2": "-sub2" }],
    [[{ name: "default" }, { name: "sub" }, { name: "sub2" }, { name: "login-3" }], { default: "", sub: "-sub", sub2: "-sub2", "login-3": null }],
  ];
  for (const [slots, expected] of cases) {
    assert.deepEqual(Object.fromEntries(slots.map(({ name }) => [name, accountModelSuffix(slots, name)])), expected);
    assert.equal(accountModelSuffix(slots, "missing"), null);
  }
});

test("settings expose setup-token as main and flat OAuth default as sub independently of pinning", async (t) => {
  const ctx = fixture(t);
  await ctx.credentials.modify("anthropic", async (credential) => ({ ...credential, pinned: "default" }));
  const claude = (await statusJson(ctx)).providers.find((provider) => provider.id === "anthropic");
  assert.deepEqual(claude.accounts.map(({ name, modelSuffix, pinned }) => ({ name, modelSuffix, pinned })), [
    { name: "default", modelSuffix: "-sub", pinned: true },
    { name: "setup-token", modelSuffix: "", pinned: false },
  ], "pinning changes placement policy, never which model row names an account");
});
