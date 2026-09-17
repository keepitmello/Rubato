import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createCliInteraction,
  oauthPresence,
  printStatus,
  resolveLoginProvider,
} from "./rubato-auth.mjs";

test("login aliases map to engine provider ids", () => {
  assert.deepEqual(resolveLoginProvider("xai"), { id: "xai" });
  assert.deepEqual(resolveLoginProvider("grok"), { id: "xai" });
  assert.deepEqual(resolveLoginProvider("codex"), { id: "openai-codex" });
  assert.deepEqual(resolveLoginProvider("antigravity"), { id: "google-antigravity" });
  assert.deepEqual(resolveLoginProvider("claude"), { error: "claude" });
  assert.equal(resolveLoginProvider("nope").error, "unknown");
});

test("oauth presence reads access tokens without python", () => {
  assert.equal(oauthPresence(undefined).ok, false);
  assert.equal(oauthPresence({ access: "tok" }).ok, true);
  assert.equal(oauthPresence({ expires: Date.now() - 1000, access: "tok" }).left, "expired");
});

test("status tells you to run rubato auth login, not senpi /login", () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r" } }));
  let out = "";
  const stdout = { write(chunk) { out += chunk; } };
  printStatus({
    stdout,
    env: { HOME: dir, RUBATO_AUTH_PATH: authPath, RUBATO_CLAUDE_ACCOUNT: "sub" },
    home: dir,
  });
  assert.match(out, /xAI/);
  assert.match(out, /rubato auth login openai-codex/);
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
