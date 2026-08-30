import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customPromptPath,
  loadRolePrompt,
  modelIdentityLine,
  promptForAgentStart,
  replaceSystemPrompt,
  promptNameForRole,
  TOOL_GUIDELINES,
} from "../../src/system-prompt.mjs";

const body = "# Working agreement\nYou are on rubato.";

function loaders(extra = {}) {
  return {
    loadRolePrompt: (role) => `${body}\n${promptNameForRole(role)}`,
    skillsSection: () => "The following skills provide specialized instructions for specific tasks.\n<available_skills>\n  <skill><name>demo</name></skill>\n</available_skills>",
    ...extra,
  };
}

test("lead, teammates, and assigned agents receive their role prompt", () => {
  assert.equal(promptNameForRole("lead"), "lead.pi.md");
  assert.equal(promptNameForRole("owner"), "teammate.pi.md");
  assert.equal(promptNameForRole("verifier"), "teammate.pi.md");
  assert.equal(promptNameForRole("agent"), "agent.pi.md");
});

test("current model identity is stated in the system prompt", () => {
  assert.equal(
    modelIdentityLine({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }),
    "You are GPT-5.6 Sol (openai-codex/gpt-5.6-sol).",
  );
  assert.equal(
    modelIdentityLine({ provider: "anthropic", id: "claude-opus-5", name: "Opus 5" }),
    "You are Claude Opus 5 (anthropic/claude-opus-5).",
  );
  assert.equal(
    modelIdentityLine({ provider: "xai", id: "grok-4.6", name: "Grok 4.6" }),
    "You are Grok 4.6 (xai/grok-4.6).",
  );
  assert.equal(modelIdentityLine(undefined), "");
  const next = promptForAgentStart(
    { systemPrompt: "" },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }, serviceTier: "priority" },
    "lead",
    loaders(),
  );
  assert.match(next, /You are GPT-5\.6 Sol Fast \(openai-codex\/gpt-5\.6-sol\)\./);
  assert.doesNotMatch(next, /You are undefined/);
});

test("RUBATO_SYSTEM_PROMPT_FILE replaces role prompt assembly", () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-soul-"));
  const path = join(dir, "SOUL.md");
  const soul = "# 나는 루\n우용이가 지어준 이름.";
  writeFileSync(path, soul);
  const env = { RUBATO_SYSTEM_PROMPT_FILE: path };
  assert.equal(customPromptPath(env), path);
  assert.equal(customPromptPath({}), null);
  assert.equal(loadRolePrompt("lead", { env }), soul);
  const next = replaceSystemPrompt("", "lead", {
    env,
    skillsSection: () => "",
  });
  assert.match(next, /나는 루/);
  assert.doesNotMatch(next, /Working agreement/);
});

test("replaces senpi and legacy prompts instead of appending", () => {
  const existing = [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "<Category_Context>\nYou are working on DEEP LOGICAL REASONING.\n</Category_Context>",
    "<project_context>\nkeep this\n</project_context>",
    "<memory>\nkeep memory\n</memory>",
    "<memory_metadata>\n- AGENT_ID: abc\n</memory_metadata>",
    "The following skills provide specialized instructions for specific tasks.\n- dispatched",
    "Current working directory: /tmp/ws",
  ].join("\n\n");

  const next = replaceSystemPrompt(existing, "lead", loaders());
  assert.match(next, /Working agreement/);
  assert.match(next, /keep this/);
  assert.match(next, /keep memory/);
  assert.match(next, /AGENT_ID: abc/);
  assert.match(next, /Current working directory: \/tmp\/ws/);
  assert.doesNotMatch(next, /operating inside pi/);
  assert.doesNotMatch(next, /Category_Context/);
  assert.doesNotMatch(next, /# Dispatching/);
  assert.doesNotMatch(next, /# Dispatched/);
  assert.ok(next.indexOf("Working agreement") < next.indexOf("keep this"));
  assert.equal(replaceSystemPrompt(next, "lead", loaders()), next);
});

test("owner replacement does not keep a previous legacy base", () => {
  const next = replaceSystemPrompt("legacy optimized prompt", "owner", loaders());
  assert.match(next, /teammate/);
  assert.doesNotMatch(next, /# Dispatched/);
  assert.doesNotMatch(next, /legacy optimized prompt/);
});

test("a session can see which skills exist", () => {
  // Senpi appends its listing only when it builds the prompt, and launch.mjs
  // hands it a finished one, so we add the listing ourselves.
  const next = replaceSystemPrompt("", "lead", loaders());
  assert.match(next, /The following skills provide specialized instructions/);
  assert.match(next, /<available_skills>/);
});

test("a listing already in the prompt is not doubled", () => {
  const carried = [
    "The following skills provide specialized instructions for specific tasks.",
    "<available_skills>",
    "  <skill><name>carried</name></skill>",
    "</available_skills>",
    "",
    "Current working directory: /tmp/ws",
  ].join("\n");

  const next = replaceSystemPrompt(carried, "lead", loaders());
  assert.match(next, /carried/);
  assert.doesNotMatch(next, /demo/);
  assert.equal(next.match(/<available_skills>/g).length, 1);
});

test("every role gets the shared tool guidelines and not Senpi's body", () => {
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const next = replaceSystemPrompt("legacy optimized prompt\n## Intent Gate\n> I read this as", role, loaders());
    assert.match(next, /## Tool Guidelines/);
    assert.ok(next.includes(TOOL_GUIDELINES));
    assert.match(next, /instead of cat or sed/);
    assert.match(next, /one eval cell/);
    assert.match(next, /one todo operation at a time/);
    assert.match(next, /memory tool/);
    assert.doesNotMatch(next, /I read this as/);
    assert.doesNotMatch(next, /legacy optimized prompt/);
    assert.doesNotMatch(next, /# Dispatching/);
    assert.doesNotMatch(next, /# Dispatched/);
  }
});
