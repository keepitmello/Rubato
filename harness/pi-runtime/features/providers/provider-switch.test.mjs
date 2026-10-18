import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  currentDisabledProviders,
  readDisabledProviders,
  setProviderDisabled,
  withoutDisabledProviders,
  readAccountLoadBalancing,
  setAccountLoadBalancing,
} from "./provider-switch.mjs";

function home(text) {
  const dir = mkdtempSync(join(tmpdir(), "rb-provider-switch-"));
  if (text !== undefined) {
    mkdirSync(join(dir, ".rubato"));
    writeFileSync(join(dir, ".rubato", "rubato.jsonc"), text);
  }
  return dir;
}

const models = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "cursor", id: "composer-2.5" },
  { provider: "cursor", id: "kimi-k3" },
];

test("a disabled provider's models leave the available list; the rest stay", () => {
  assert.deepEqual(withoutDisabledProviders(models, new Set(["cursor"])).map((m) => m.id), ["claude-opus-5-5"]);
  assert.equal(withoutDisabledProviders(models, new Set()), models);
});

test("the same list and settings give back the same array", () => {
  const dir = home('{ "providers": { "disabled": ["cursor"] } }');
  try {
    const disabled = currentDisabledProviders(dir);
    assert.equal(withoutDisabledProviders(models, disabled), withoutDisabledProviders(models, disabled));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("everything stays on without a config file or with a broken one", () => {
  const none = home();
  const broken = home("{ providers: ");
  try {
    assert.equal(readDisabledProviders({ home: none }).size, 0);
    assert.equal(readDisabledProviders({ home: broken }).size, 0);
  } finally {
    rmSync(none, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});

test("disable and enable edit providers.disabled and keep the user's comments and keys", () => {
  const dir = home('{\n  // my titles\n  "titles": { "models": ["anthropic/claude-haiku-5-5"] }\n}\n');
  const file = join(dir, ".rubato", "rubato.jsonc");
  try {
    assert.deepEqual(setProviderDisabled("cursor", true, { home: dir }), ["cursor"]);
    assert.deepEqual(setProviderDisabled("b-ai", true, { home: dir }), ["b-ai", "cursor"]);
    let text = readFileSync(file, "utf8");
    assert.match(text, /\/\/ my titles/);
    assert.deepEqual([...readDisabledProviders({ home: dir })], ["b-ai", "cursor"]);
    setProviderDisabled("cursor", false, { home: dir });
    assert.deepEqual(setProviderDisabled("b-ai", false, { home: dir }), []);
    text = readFileSync(file, "utf8");
    // An empty list removes the key, and the empty providers object with it.
    assert.doesNotMatch(text, /providers/);
    assert.match(text, /claude-haiku-5-5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a change to the file is seen without a restart", () => {
  const dir = home('{ "providers": { "disabled": ["cursor"] } }');
  const file = join(dir, ".rubato", "rubato.jsonc");
  try {
    assert.deepEqual([...currentDisabledProviders(dir)], ["cursor"]);
    writeFileSync(file, '{ "providers": { "disabled": ["cursor", "kiro"] } }');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual([...currentDisabledProviders(dir)], ["cursor", "kiro"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("account load balancing is opt-in, persists, and keeps other provider settings", () => {
  const dir = home('{\n // keep me\n "providers": { "disabled": ["cursor"] }\n}');
  try {
    assert.equal(readAccountLoadBalancing({ home: dir }).has("anthropic"), false);
    setAccountLoadBalancing("anthropic", true, { home: dir });
    assert.equal(readAccountLoadBalancing({ home: dir }).has("anthropic"), true);
    assert.deepEqual([...readDisabledProviders({ home: dir })], ["cursor"]);
    setAccountLoadBalancing("anthropic", false, { home: dir });
    assert.equal(readAccountLoadBalancing({ home: dir }).has("anthropic"), false);
    assert.match(readFileSync(join(dir, ".rubato", "rubato.jsonc"), "utf8"), /keep me/);
    assert.throws(() => setAccountLoadBalancing("cursor", true, { home: dir }), /supported for Anthropic/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
