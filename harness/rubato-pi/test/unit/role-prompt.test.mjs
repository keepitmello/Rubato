import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignedRoleSection, loadRolePrompt, promptNameForRole, replaceSystemPrompt,
} from "../../src/system-prompt.mjs";
import { createPromptFixture, promptSourceRoot } from "../helpers/prompt-fixture.mjs";

const fixture = createPromptFixture();
after(() => fixture.dispose());
const source = (file) => readFileSync(join(promptSourceRoot, file), "utf8");
const built = (role) => loadRolePrompt(role, { env: fixture.env });
const composed = (role, existing = "") => replaceSystemPrompt(existing, role, {
  env: fixture.env, argv: [], skillsSection: () => "",
});
const allRoles = ["lead", "owner", "verifier", "agent"];

// Assembly contracts only: which fragments reach which role, and that the
// runtime role section is stable. Prompt wording is not pinned here.

test("roles share only the intended source fragments and preserve voice", () => {
  const voice = source("voice.md").trim();
  const cases = [
    ["lead", ["base.pi.md", "brief-exchange.pi.md", "core-lead.pi.md"]],
    ["owner", ["base.pi.md", "brief-exchange.pi.md", "core-teammate.pi.md"]],
    ["verifier", ["base.pi.md", "brief-exchange.pi.md", "core-teammate.pi.md"]],
    ["agent", ["base.pi.md", "core-agent.pi.md"]],
  ];
  for (const [role, fragments] of cases) {
    for (const fragment of fragments) assert.ok(built(role).includes(source(fragment).trim()));
    assert.ok(built(role).trim().endsWith(voice));
  }
  assert.equal(promptNameForRole("owner"), promptNameForRole("verifier"));
  assert.equal(built("owner"), built("verifier"));
  assert.notEqual(composed("owner"), composed("verifier"));
});

test("no role build imports another runtime's rails", () => {
  for (const role of allRoles) {
    assert.doesNotMatch(built(role), /FX_SUBAGENT_SYSTEM_PROMPT_FILE|## Rails — fx|\.fx\//);
  }
});

test("runtime assignment is stable, specific, idempotent and independent of model tier", () => {
  for (const role of allRoles) {
    const first = composed(role, "<project_context>keep</project_context>\nCurrent working directory: /tmp/work");
    assert.match(first, new RegExp(`Role: ${role}\\b`));
    assert.match(first, /<project_context>keep/);
    assert.equal((first.match(/## Runtime-assigned role/g) ?? []).length, 1);
    assert.equal(composed(role, first), first);
  }
  assert.equal(assignedRoleSection("unknown"), "");
  assert.equal(assignedRoleSection("__proto__"), "");
  assert.equal(assignedRoleSection(undefined), "");
});
