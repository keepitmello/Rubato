import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { skillsSection } from "./skills-section.mjs";

const SKILLS_SECTION = "The following skills provide specialized instructions";

export const TOOL_GUIDELINES = `## Tool Guidelines

- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly).
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls.
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Use one todo operation at a time; batch it with the real work rather than making a solo todo turn. Reference tasks and phases by their exact content/name.
- If a step needs more than one tool call, prefer one eval cell that runs independent calls together and returns distilled facts.
- Record durable facts, preferences, and decisions with the memory tool as you learn them; every change is committed with the reason you provide. Never let memory bookkeeping replace answering the user's current message.
- Memory files are markdown with YAML frontmatter; keep each block's description accurate because the memory index surfaces it.
- Use memory_apply_patch for multi-file or multi-hunk memory edits; prefer the memory tool for single-block changes.
- Settle workspace-grounded judgments from local evidence. Add Skill(consult) when current external evidence, unfamiliar-domain research, or an independent read can materially change a costly decision, then compare its evidence with the workspace before deciding. Its deterministic Aside REPL path sends one self-contained packet to GPT-5.6 in the configured ChatGPT project and returns evidence for local verification. Choose exactly one explicit quality tier, \`--quality xhigh\` or \`--quality pro\`. Aside's adaptive agent handles UI-drift recovery; the deterministic runner handles normal sends.
- Use Aside directly, through Skill(browser-cli) and Skill(aside-browser), for logged-in interactive browser work outside the Consult packet workflow. Consult already owns its own Aside project route.
- web_search and web_fetch are the fallback, not the default: a quick fact check or a public page a plain GET can read. Anything heavier goes to consult or Aside first.
`.trim();

export function rolePromptsRoot(env = process.env) {
  if (env.RUBATO_PROMPTS_DIR) return env.RUBATO_PROMPTS_DIR;
  return join(homedir(), ".agents", "rubato");
}

// A single file instead of assembling one from pieces (base + core + voice).
// rubato-soul sets this to ~/Documents/SOUL.md.
export function customPromptPath(env = process.env) {
  const path = env.RUBATO_SYSTEM_PROMPT_FILE;
  return path && path.length > 0 ? path : null;
}

// Four roles, three prompt files: owner and verifier share `teammate.pi.md`
// because verification is a workstream whose artifact is a judgement. A plain
// task child is an `agent`: it receives one brief and returns evidence.
//
// The `.pi` in the filename is lineage: these are built from the pi pieces in
// harness/prompts/. The fx runtime that owned the unsuffixed build is gone.
export function promptNameForRole(role) {
  if (role === "lead") return "lead.pi.md";
  if (role === "agent") return "agent.pi.md";
  return "teammate.pi.md";
}

export function isCloudStubReadError(error) {
  const errno = Number(error?.errno);
  if (errno === 11 || errno === -11) return true;
  const code = String(error?.code ?? "");
  if (code === "EDEADLK" || code === "EAGAIN") return true;
  return /deadlock|unknown system error -11/i.test(String(error?.message ?? error ?? ""));
}

export function materializeLocalFile(path, { spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
  if (platform !== "darwin" || typeof path !== "string" || path.length === 0) return false;
  const result = spawnSyncImpl("chflags", ["nodataless", path], { stdio: "ignore" });
  return result?.status === 0;
}

function promptReadError(path, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `rubato-pi system prompt unreadable: ${path} (${detail}). ` +
      "iCloud Optimize 로 파일이 이 맥에 없을 수 있다. Finder 에서 한 번 열거나 Always Keep Downloaded 로 고정해라.",
  );
}

export function readPromptFile(path, {
  readFile = readFileSync,
  materialize = materializeLocalFile,
} = {}) {
  try {
    return readFile(path, "utf8");
  } catch (error) {
    if (!isCloudStubReadError(error)) throw promptReadError(path, error);
    materialize(path);
    try {
      return readFile(path, "utf8");
    } catch (retryError) {
      throw promptReadError(path, retryError);
    }
  }
}

export function loadRolePrompt(role, {
  env = process.env,
  readFile = readFileSync,
  materialize = materializeLocalFile,
} = {}) {
  const custom = customPromptPath(env);
  const path = custom ?? join(rolePromptsRoot(env), ".build", promptNameForRole(role));
  if (!existsSync(path)) {
    throw new Error(
      custom
        ? `rubato-pi system prompt missing: ${path}`
        : `rubato-pi role prompt missing: ${path}`,
    );
  }
  return readPromptFile(path, { readFile, materialize });
}

export function modelIdentityLine(model, serviceTier) {
  const id = model?.id;
  if (typeof id !== "string" || id.length === 0) return "";
  const provider = model?.provider;
  const catalogId = typeof provider === "string" && provider.length > 0 ? `${provider}/${id}` : id;
  const displayName = typeof model.name === "string" && model.name.length > 0 ? model.name : id;
  const brandedName = provider === "anthropic" && !/^claude\b/i.test(displayName)
    ? `Claude ${displayName}`
    : displayName;
  const name = serviceTier === "priority" && !/\bfast\b/i.test(brandedName) ? `${brandedName} Fast` : brandedName;
  return `You are ${name} (${catalogId}).`;
}

export function promptForAgentStart(event, ctx, role, hooks = {}) {
  return replaceSystemPrompt(event.systemPrompt ?? "", role, {
    ...hooks,
    model: ctx.model,
    serviceTier: ctx.serviceTier,
  });
}

export function extractHarnessExtras(existing) {
  const extras = [];
  const take = (pattern) => {
    const match = existing.match(pattern);
    if (match) extras.push(match[0].trim());
  };
  take(/<project_context>[\s\S]*?<\/project_context>/);
  take(/<memory>[\s\S]*?<\/memory>/);
  take(/<memory_metadata>[\s\S]*?<\/memory_metadata>/);
  take(new RegExp(`${SKILLS_SECTION}[\\s\\S]*?(?=\\nCurrent working directory:|$)`));
  take(/Current working directory: [^\n]+/);
  return extras;
}

export function replaceSystemPrompt(existing, role, hooks = {}) {
  const load = hooks.loadRolePrompt ?? ((nextRole) => loadRolePrompt(nextRole, hooks));
  const parts = [load(role).trim(), modelIdentityLine(hooks.model, hooks.serviceTier), TOOL_GUIDELINES];
  const extras = extractHarnessExtras(existing ?? "");
  parts.push(...extras);
  // Senpi only appends its own skill listing when it builds the prompt itself,
  // and launch.mjs hands it a finished one so the stock prompt never stands up.
  // Without this the session cannot see which skills exist. Skip it when the
  // incoming prompt already carried a listing, so the two never stack.
  if (!extras.some((part) => part.startsWith(SKILLS_SECTION))) {
    const listSkills = hooks.skillsSection ?? skillsSection;
    parts.push(listSkills());
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}
