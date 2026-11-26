// A check before the companion hands work to a lead: `session_create` (always a brief) and a
// `session_send` long enough to be one. The call is stopped once with one line that points at the two
// skills, and goes through as soon as this turn has read both. The skill's own "read before every spawn"
// never reaches a companion, which starts leads with session tools instead of `Agent`, and a reminder
// after the send came too late: the brief had already left.
//
// The one condition to pass is the two reads, nothing else: a second try with no reading is stopped
// again. A run is the turn the last user or wake message opened (agent_start), so the next turn must read
// again. A short `session_send` (under SHORT_SEND chars: a stop, a yes, a decision handed on) is an
// operating message, not a brief, and is never stopped. The skills' content is not carried here; the line
// only says what to read and to do.
//
// Only a companion session loads this (bootstrap.mjs adds companion-home for RUBATO_PI_ROLE=companion), so a
// lead or any other conversation never sees it.
import { opensSkill } from "./prompt-piece-reminder.mjs";

export const DISPATCH_SKILL = "dispatching";
export const MODEL_SKILL = "model-guide";
export const SHORT_SEND = 200;
export const DISPATCH_BLOCK = `일을 넘기기 전에 skill(${DISPATCH_SKILL})(~/.agents/skills/${DISPATCH_SKILL}/SKILL.md)로 브리프를 쓰고 ` +
  `skill(${MODEL_SKILL})(~/.agents/skills/${MODEL_SKILL}/SKILL.md)로 모델을 고른 뒤 다시 보내.`;

/** Whether this call hands over work: a new lead, or a message long enough to be a brief. */
export function sendsBrief(event) {
  if (event?.toolName === "session_create") return true;
  return event?.toolName === "session_send" && String(event.input?.text ?? "").trim().length >= SHORT_SEND;
}

export function installDispatchReminder(pi) {
  const read = new Set();
  const reading = new Map();
  pi.on("agent_start", () => { read.clear(); reading.clear(); });
  pi.on("tool_call", (event) => {
    if (sendsBrief(event)) return read.has(DISPATCH_SKILL) && read.has(MODEL_SKILL) ? undefined : { block: true, reason: DISPATCH_BLOCK };
    for (const skill of [DISPATCH_SKILL, MODEL_SKILL]) if (opensSkill(event, skill)) reading.set(event.toolCallId, skill);
    return undefined;
  });
  // A read that failed has not opened the skill.
  pi.on("tool_result", (event) => {
    const skill = reading.get(event?.toolCallId);
    reading.delete(event?.toolCallId);
    if (skill && !event?.isError) read.add(skill);
    return undefined;
  });
}
