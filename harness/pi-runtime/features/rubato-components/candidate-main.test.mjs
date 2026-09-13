import assert from "node:assert/strict";
import test from "node:test";
import { pinCandidateProfile } from "./candidate-main.mjs";

const KEYS = [
  "PI_PACKAGE_DIR",
  "PI_MANAGED_INSTALL_ROOT",
  "PI_CODING_AGENT_DIR",
  "RUBATO_PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
];

test("candidate profile pin does not flatten sessions onto the parent folder", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.PI_MANAGED_INSTALL_ROOT = "/poison/managed";
    process.env.PI_CODING_AGENT_SESSION_DIR = "/poison/sessions";
    pinCandidateProfile("/abs/agent");
    assert.equal(process.env.PI_CODING_AGENT_DIR, "/abs/agent");
    assert.equal(process.env.RUBATO_PI_CODING_AGENT_DIR, "/abs/agent");
    assert.equal(process.env.PI_MANAGED_INSTALL_ROOT, undefined);
    assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
