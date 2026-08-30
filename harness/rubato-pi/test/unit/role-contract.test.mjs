import test from "node:test";
import assert from "node:assert/strict";
import { resolveRole } from "../../src/role-contract.mjs";

test("member env falls back to owner unless an explicit role is set", () => {
  assert.equal(resolveRole({ env: {} }), "lead");
  assert.equal(resolveRole({ env: { SENPI_TASK_MEMBER: "alpha" } }), "owner");
  assert.equal(
    resolveRole({ env: { SENPI_TASK_MEMBER: "alpha", RUBATO_PI_ROLE: "verifier" } }),
    "verifier",
  );
});
