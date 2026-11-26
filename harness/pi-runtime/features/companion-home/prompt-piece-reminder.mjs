// A reminder that rides on the result of any tool call that writes one of the companion's own prompt
// pieces: the file tools (write, edit, apply_patch), a shell that changed one (python, sed, a
// redirect: seen by comparing the files before and after, so no command is parsed), and a
// `companion_settings` proposal for a piece. It never blocks. The companion reads it where it already
// looks, in the result of the call it just made, so it works when the companion has forgotten the
// skill exists (the skill's "문장 대신 길을 내").
//
// Only a companion session loads this (bootstrap.mjs adds companion-home for RUBATO_PI_ROLE=companion),
// so a lead or any other conversation never sees it. A run that already opened the skill is not
// reminded again; the next run, which is a new turn, is.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { segnoPaths } from "./home.mjs";

export const PIECE_SKILL = "prompting-principles";
export const PIECE_REMINDER = `시스템 프롬프트 조각을 고치는 중이야. ${PIECE_SKILL} 스킬을 먼저 열고 그 결대로 써. ` +
  "덧대지 말고 그 섹션을 내 말로 처음부터 다시, 내가 원하는 모습 그대로 쓰고, 사용자가 한 말을 원문 그대로 붙이지 않아.";

const PIECE_NAMES = Object.freeze(["preamble", "soul", "identity", "user", "companion", "coda"]);
const WRITING_TOOLS = Object.freeze({ write: "path", edit: "path" });

/** The files that are the companion's own pieces: absolute paths, and the folder of lead-role pieces. */
export function pieceFiles(env = process.env) {
  const { home, resident } = segnoPaths(env);
  const files = new Set([resident, ...PIECE_NAMES.map((name) => path.join(home, "prompt", `${name}.md`))]);
  // A registered companion's own mapping of a piece to a file elsewhere.
  try {
    for (const file of Object.values(JSON.parse(env.RUBATO_COMPANION_PROMPT_FILES || "{}")))
      if (typeof file === "string" && path.isAbsolute(file)) files.add(path.resolve(file));
  } catch { /* an unreadable mapping names no extra files */ }
  const roles = path.join(home, "prompt", "lead-roles");
  return { files, roles };
}

function isPiece(file, { files, roles }) {
  const target = path.resolve(file);
  return files.has(target) || (path.dirname(target) === roles && target.endsWith(".md"));
}

/** Every piece file that exists now, with a fingerprint of its text (null for one not there). */
function fingerprints(pieces) {
  const found = new Map();
  const names = new Set(pieces.files);
  try { for (const name of readdirSync(pieces.roles)) if (name.endsWith(".md")) names.add(path.join(pieces.roles, name)); } catch { /* no lead-roles folder */ }
  for (const file of names) {
    try { found.set(file, createHash("sha1").update(readFileSync(file)).digest("hex")); } catch { found.set(file, null); }
  }
  return found;
}

const changed = (before, after) => [...after].some(([file, hash]) => before.get(file) !== hash);

/** Whether this call writes a piece by what it says it does (not for a shell: that one is judged by the files). */
function namesPiece(event, cwd, pieces) {
  const resolve = (target) => typeof target === "string" && target.trim() && isPiece(path.resolve(cwd, target.trim().replace(/^@/, "")), pieces);
  const field = WRITING_TOOLS[event?.toolName];
  if (field) return resolve(event.input?.[field]);
  if (event?.toolName === "apply_patch" && typeof event.input?.input === "string")
    return [...event.input.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].some((match) => resolve(match[1]));
  if (event?.toolName === "companion_settings")
    return event.input?.action === "propose" && typeof event.input?.proposal?.piece === "string";
  return false;
}

const SKILL_FILE = new RegExp(`${PIECE_SKILL}/SKILL\\.md`);
const SHELL_READER = /^\s*(?:cat|head|tail|less|more|nl|bat|sed\s+-n|rg|grep)\b[^|;&<>]*/;

/** Whether this call reads the skill: the file tool on its SKILL.md, or a shell that only prints it. */
function opensSkill(event) {
  if (event?.toolName === "read") return SKILL_FILE.test(String(event.input?.path ?? ""));
  if (event?.toolName === "bash") {
    const command = String(event.input?.command ?? "");
    return SHELL_READER.test(command) && SKILL_FILE.test(command);
  }
  return false;
}

export function installPromptPieceReminder(pi, { env = process.env } = {}) {
  let skillOpened = false;
  const shellsBefore = new Map();
  const pieces = () => pieceFiles(env);
  pi.on("agent_start", () => { skillOpened = false; shellsBefore.clear(); });
  pi.on("tool_call", (event, ctx) => {
    if (opensSkill(event)) skillOpened = true;
    if (event?.toolName === "bash") shellsBefore.set(event.toolCallId, fingerprints(pieces()));
    return undefined;
  });
  pi.on("tool_result", (event, ctx) => {
    const before = shellsBefore.get(event?.toolCallId);
    shellsBefore.delete(event?.toolCallId);
    if (skillOpened) return undefined;
    const set = pieces();
    const writes = before ? changed(before, fingerprints(set)) : namesPiece(event, ctx?.cwd || segnoPaths(env).home, set);
    if (!writes) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: `\n\n${PIECE_REMINDER}` }] };
  });
}
