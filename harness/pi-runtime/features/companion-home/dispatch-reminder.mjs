// A reminder for the companion when it hands work to a lead: `session_create` (always a brief) and a
// `session_send` long enough to be one. It never blocks. The skill's own "read before every spawn" never
// reaches a companion, which starts leads with session tools instead of `Agent`, so the reminder sits where
// the companion does look.
//
// Two places, because no hook runs between the companion writing a brief and the call leaving:
//   - before the call: session-link's companion tool descriptions (DISPATCH_HINT there) name the skill and
//     the three rules; the model reads a description every time it chooses a tool.
//   - after the call, here: the result carries the reminder for the next brief (a follow-up counts), and
//     says what to do when the brief just sent put a guess in the goal's place.
// A run that has already opened the skill is not reminded again; the next run (a new turn) is. A short
// `session_send` (under SHORT_SEND chars: a stop, a yes, a fact the lead asked for) carries nothing: it is an
// operating message, not a brief, and a reminder on each would teach the companion to skim all of them.
//
// Only a companion session loads this (bootstrap.mjs adds companion-home for RUBATO_PI_ROLE=companion), so a
// lead or any other conversation never sees it.
import { opensSkill } from "./prompt-piece-reminder.mjs";

export const DISPATCH_SKILL = "dispatching";
export const SHORT_SEND = 200;
export const DISPATCH_REMINDER = `리드한테 일을 넘겼어. 다음 브리프(후속 지시도 새 일이면 똑같이)를 쓰기 전에 ${DISPATCH_SKILL} 스킬(~/.agents/skills/${DISPATCH_SKILL}/SKILL.md)을 열어. ` +
  "목표·다 됐다는 증거·손대면 안 되는 것은 단단하게 적고, 내 짐작(원인·모양·위치)은 리드가 확인할 단서로 따로 두고 목표 자리에 넣지 않아. 모르는 건 사실처럼 쓰지 말고 \"확인해 와\"로 맡겨. " +
  "방금 보낸 브리프의 목표 자리에 짐작이 들어갔으면 리드가 파기 전에 바로잡아 다시 보내.";

/** Whether this call hands over work: a new lead, or a message long enough to be a brief. */
export function sendsBrief(event) {
  if (event?.toolName === "session_create") return true;
  return event?.toolName === "session_send" && String(event.input?.text ?? "").trim().length >= SHORT_SEND;
}

export function installDispatchReminder(pi) {
  let skillOpened = false;
  pi.on("agent_start", () => { skillOpened = false; });
  pi.on("tool_call", (event) => {
    if (opensSkill(event, DISPATCH_SKILL)) skillOpened = true;
    return undefined;
  });
  pi.on("tool_result", (event) => {
    if (skillOpened || event?.isError || !sendsBrief(event)) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: `\n\n${DISPATCH_REMINDER}` }] };
  });
}
