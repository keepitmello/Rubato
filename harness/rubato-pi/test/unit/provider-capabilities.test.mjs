import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_PROVIDER_IDS,
  admitProviders,
  validateProviderAdmission,
} from "../../src/provider-capabilities.mjs";

const providers = () => SUPPORTED_PROVIDER_IDS.map((id) => ({ id }));

test("provider capability SSOT keeps the seven product lanes in registration order", () => {
  assert.deepEqual([...SUPPORTED_PROVIDER_IDS], [
    "openai-codex",
    "xai",
    "cursor",
    "anthropic",
    "kiro",
    "google-antigravity",
    "opencode",
  ]);
  assert.equal(Object.isFrozen(SUPPORTED_PROVIDER_IDS), true);
});

test("validation returns an immutable copy of a complete ordered set", () => {
  const input = providers();
  const admitted = validateProviderAdmission(input);
  assert.notEqual(admitted, input);
  assert.equal(Object.isFrozen(admitted), true);
  assert.deepEqual(admitted.map((provider) => provider.id), [...SUPPORTED_PROVIDER_IDS]);
});

test("a missing, duplicate, unexpected, malformed, or reordered lane is rejected", () => {
  assert.throws(() => validateProviderAdmission(providers().slice(0, -1)), /missing=opencode/);
  assert.throws(
    () => validateProviderAdmission([...providers().slice(0, -1), { id: "google-antigravity" }]),
    /duplicate provider id\(s\): google-antigravity/,
  );
  assert.throws(
    () => validateProviderAdmission([...providers().slice(0, -1), { id: "foreign" }]),
    /missing=opencode unexpected=foreign/,
  );
  assert.throws(() => validateProviderAdmission([...providers().slice(0, -1), {}]), /index 6 has no id/);
  const reordered = providers();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(() => validateProviderAdmission(reordered), /provider order mismatch/);
});

test("admission performs zero registrations until the whole set validates", () => {
  const calls = [];
  const pi = { registerProvider: (provider) => calls.push(provider.id) };
  assert.throws(() => admitProviders(pi, providers().slice(0, -1)), /missing=opencode/);
  assert.deepEqual(calls, []);

  admitProviders(pi, providers());
  assert.deepEqual(calls, [...SUPPORTED_PROVIDER_IDS]);
});
