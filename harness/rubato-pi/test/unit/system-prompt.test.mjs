import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  customPromptPath,
  defaultReturnDetailPath,
  dispatchedSkillSection,
  isCloudStubReadError,
  isNonInteractiveCli,
  loadRolePrompt,
  materializeLocalFile,
  modelIdentityLine,
  promptForAgentStart,
  readPromptFile,
  replaceSystemPrompt,
  promptNameForRole,
  returnSkillSection,
  skillMarkdownBody,
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
  assert.doesNotMatch(next, /# Return/);
  assert.ok(next.indexOf("Working agreement") < next.indexOf("keep this"));
  assert.equal(replaceSystemPrompt(next, "lead", loaders()), next);
});

test("owner replacement does not keep a previous legacy base", () => {
  const next = replaceSystemPrompt("legacy optimized prompt", "owner", loaders());
  assert.match(next, /teammate/);
  assert.doesNotMatch(next, /# Dispatched/);
  assert.doesNotMatch(next, /# Return/);
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
    assert.doesNotMatch(next, /# Return/);
  }
});

test("iCloud dataless read errors are recognized", () => {
  assert.equal(isCloudStubReadError({ errno: -11, message: "Unknown system error -11" }), true);
  assert.equal(isCloudStubReadError({ code: "EDEADLK" }), true);
  assert.equal(isCloudStubReadError({ message: "Resource deadlock avoided" }), true);
  assert.equal(isCloudStubReadError({ code: "ENOENT" }), false);
});

test("cloud stub reads retry after materialize", () => {
  let reads = 0;
  const seen = [];
  const text = readPromptFile("/tmp/SOUL.md", {
    readFile: () => {
      reads += 1;
      if (reads === 1) {
        const error = new Error("Unknown system error -11: Unknown system error -11, read");
        error.errno = -11;
        throw error;
      }
      return "# 나는 루\n";
    },
    materialize: (path) => {
      seen.push(path);
    },
  });
  assert.equal(text, "# 나는 루\n");
  assert.deepEqual(seen, ["/tmp/SOUL.md"]);
  assert.equal(reads, 2);
});

test("unreadable custom prompt explains the iCloud stub", () => {
  assert.throws(
    () => readPromptFile("/tmp/SOUL.md", {
      readFile: () => {
        const error = new Error("Unknown system error -11: Unknown system error -11, read");
        error.errno = -11;
        throw error;
      },
      materialize: () => false,
    }),
    /iCloud Optimize/,
  );
});

test("darwin materialize uses chflags nodataless", () => {
  const seen = [];
  const ok = materializeLocalFile("/tmp/SOUL.md", {
    platform: "darwin",
    spawnSyncImpl: (cmd, args) => {
      seen.push([cmd, ...args]);
      return { status: 0 };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, [["chflags", "nodataless", "/tmp/SOUL.md"]]);
  assert.equal(materializeLocalFile("/tmp/SOUL.md", { platform: "linux", spawnSyncImpl: () => { throw new Error("no"); } }), false);
});

test("rubato-soul materializes iCloud stubs before launch", () => {
  const script = readFileSync(fileURLToPath(new URL("../../../scripts/rubato-soul.sh", import.meta.url)), "utf8");
  assert.match(script, /chflags nodataless/);
  assert.match(script, /읽을 수 없다/);
});

test("print and json CLI flags are non-interactive; rpc and text are not", () => {
  assert.equal(isNonInteractiveCli(["--print", "hello"]), true);
  assert.equal(isNonInteractiveCli(["-p", "hello"]), true);
  assert.equal(isNonInteractiveCli(["--mode", "json"]), true);
  assert.equal(isNonInteractiveCli(["--mode=json"]), true);
  assert.equal(isNonInteractiveCli(["--mode", "print"]), true);
  assert.equal(isNonInteractiveCli(["--mode=print"]), true);
  assert.equal(isNonInteractiveCli(["--mode", "rpc"]), false);
  assert.equal(isNonInteractiveCli(["--mode", "text"]), false);
  assert.equal(isNonInteractiveCli([]), false);
  assert.equal(isNonInteractiveCli(["--model", "xai/grok-4.6"]), false);
});

test("print sessions inline the dispatched contract; interactive ones do not", () => {
  const dispatched = () => "# Dispatched\nProvisional: the sender's reading, not ground truth.";
  const returned = () => "# Return\nBoss report only.";
  const printed = replaceSystemPrompt("", "lead", {
    ...loaders(),
    argv: ["--print", "hello"],
    dispatchedSkillSection: dispatched,
    returnSkillSection: returned,
  });
  assert.match(printed, /# Dispatched/);
  assert.match(printed, /Provisional: the sender's reading/);
  assert.match(printed, /# Return/);
  assert.match(printed, /Boss report only/);
  assert.ok(printed.indexOf("Working agreement") < printed.indexOf("# Dispatched"));
  assert.ok(printed.indexOf("# Dispatched") < printed.indexOf("# Return"));

  const interactive = replaceSystemPrompt("", "lead", { ...loaders(), argv: [] });
  assert.doesNotMatch(interactive, /# Dispatched/);
  assert.doesNotMatch(interactive, /# Return/);

  const rpc = replaceSystemPrompt("", "lead", { ...loaders(), argv: ["--mode", "rpc"] });
  assert.doesNotMatch(rpc, /# Dispatched/);
  assert.doesNotMatch(rpc, /# Return/);
});

test("agent start inherits process argv so a print child keeps the contract after rebuild", () => {
  const next = promptForAgentStart(
    { systemPrompt: "" },
    { model: { provider: "xai", id: "grok-4.6", name: "Grok 4.6" } },
    "agent",
    {
      ...loaders(),
      argv: ["--mode", "json"],
      dispatchedSkillSection: () => "# Dispatched\nProvisional: sender reading.",
      returnSkillSection: () => "# Return\nBoss report only.",
    },
  );
  assert.match(next, /# Dispatched/);
  assert.match(next, /Provisional: sender reading/);
  assert.match(next, /# Return/);
});

test("the bundled dispatched skill body is what print sessions receive", () => {
  const body = dispatchedSkillSection({
    dirs: [],
    dispatchedPath: fileURLToPath(new URL("../../../skills/dispatched/SKILL.md", import.meta.url)),
  });
  assert.match(body, /# Dispatched/);
  assert.match(body, /Provisional:/);
  assert.doesNotMatch(body, /^---/);
  assert.equal(skillMarkdownBody("---\nname: x\n---\n\n# Hello\n"), "# Hello");
});

test("print sessions receive the bundled return contract and a concrete detail path", () => {
  const section = returnSkillSection({
    dirs: [],
    returnPath: fileURLToPath(new URL("../../../skills/return/SKILL.md", import.meta.url)),
    argv: ["--print", "hello"],
    env: {},
    now: () => Date.UTC(2026, 8, 2, 0, 0, 0),
    home: () => "/tmp/fake-home",
  });
  assert.match(section, /# Return/);
  assert.match(section, /Boss report only/);
  assert.doesNotMatch(section, /^---/);
  assert.match(section, /This run's detail file: \/tmp\/fake-home\/\.rubato-pi\/agent\/reports\/2026-09-02T00-00-00-000Z-return\.md/);
});

test("return detail path sits next to the session file, or under reports when there is none", () => {
  assert.equal(
    defaultReturnDetailPath({ argv: ["--session", "/tmp/sess/abc.jsonl"], env: {} }),
    "/tmp/sess/abc.jsonl.return.md",
  );
  assert.equal(
    defaultReturnDetailPath({ argv: ["--session=/tmp/sess/abc.jsonl"], env: {} }),
    "/tmp/sess/abc.jsonl.return.md",
  );
  assert.equal(
    defaultReturnDetailPath({ argv: ["--print", "--no-session"], env: { RUBATO_RETURN_DETAIL: "/tmp/forced.md" } }),
    "/tmp/forced.md",
  );
  assert.equal(
    defaultReturnDetailPath({
      argv: ["--print", "--no-session"],
      env: { RUBATO_PI_CODING_AGENT_DIR: "/tmp/agent-home" },
      now: () => Date.UTC(2026, 8, 2, 12, 0, 0),
    }),
    "/tmp/agent-home/reports/2026-09-02T12-00-00-000Z-return.md",
  );
});
