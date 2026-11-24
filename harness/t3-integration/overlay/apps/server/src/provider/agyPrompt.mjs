import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const GENERATED_MARK =
  "<!-- Rubato 설치기가 harness/prompts 의 리드 프롬프트로 만든다. 고친 내용을 지키려면 이 줄을 지워라. -->";

export function agentHeader(name, description, generated = false) {
  return [
    "---", ...(generated ? [`# ${GENERATED_MARK}`] : []),
    `name: ${name}`, `description: ${description}`, "mainAgent: true", "subagent: false",
    "excludeDefaultComponents: true", "inheritMcp: true", "tools:",
    ...["read_file", "write_file", "edit_file", "run_command", "invoke_subagent", "manage_subagents"].map(t => `  - ${t}`),
    "commandExecutionPolicy: sandbox", "---",
  ].join("\n");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const recordFile = (state, thread) =>
  path.join(state, "rubato-agy-prompts", hash(thread) + ".json");

// Snapshot at prepare. The state directory belongs to this T3 environment, not to a Google login.
export async function savePrompt(state, thread, prompt) {
  const file = recordFile(state, thread);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = { ...prompt, createdAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }).catch(async error => {
    if (error.code !== "EEXIST") throw error;
    const saved = await readPrompt(state, thread);
    if (saved.text !== prompt.text || saved.label !== prompt.label || saved.source !== prompt.source)
      throw new Error("This conversation already has a different prompt.");
    value.createdAt = saved.createdAt;
  });
  const { text, ...summary } = value;
  return summary;
}

export async function readPrompt(state, thread) {
  try { return JSON.parse(await readFile(recordFile(state, thread), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Use the runtime's real home; isolated profiles link this directory before ACP starts.
// Refresh our generated header without treating a mark in someone's prompt body as ownership.
export async function installPromptAgent(home, text) {
  const name = `rubato-prompt-${hash(text)}`;
  const file = path.join(home, ".gemini", "config", "agents", `${name}.md`);
  const content = `${agentHeader(name, "Rubato conversation", true)}\n${text}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { flag: "wx", mode: 0o600 }).catch(async error => {
    if (error.code !== "EEXIST") throw error;
    const current = await readFile(file, "utf8");
    if (current === content) return;
    const header = current.split(/\r?\n---\r?\n/, 1)[0];
    if (!(await lstat(file)).isFile() || !header.startsWith("---\n") || !header.split(/\r?\n/).includes(`# ${GENERATED_MARK}`))
      throw new Error(`The agy agent ${name} belongs to another file.`);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  });
  return name;
}

// The profile linker intentionally keeps a person's existing directory. Never let
// agy silently fall back to its default when that directory lacks this thread's agent.
export async function verifyProfileAgent(home, geminiHome, agent) {
  const relative = path.join("config", "agents", `${agent}.md`);
  const [expected, actual] = await Promise.all([
    readFile(path.join(home, ".gemini", relative)), readFile(path.join(geminiHome, relative)),
  ]);
  if (!expected.equals(actual)) throw new Error(`The isolated profile has a different ${agent}.`);
}
