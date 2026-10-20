// Segno's own memory, in its own words, and the things its own time reaches for.
//
// - `segno_record` writes the daily (facts, decisions, what is still open), the diary (feelings and
//   memorable exchanges, in Segno's voice), a working note, or the mood it falls asleep with.
// - `segno_search` searches Segno's own memory/ with msearch (Roo's msearch.sh over Roo's memory/).
// - `segno_commit` commits the record files Segno changed to its home's history (Roo commit-owned.sh).
// - `reply` is Segno's mouth (Roo's telegram_reply, intent companion-segno rev 11): in every turn,
//   the one the user opened too, everything else Segno writes is its own monologue, and only what it
//   sends with `reply` reaches its thread and the user's phone (bridge said-echo.mjs). `say` is the
//   same as a voice reply; it is offered once a voice is set. Both are recorded for `sent_messages`.
//   A turn the user opened that settles without either gets one reminder (Roo's
//   telegram-reply-reminder.ts), which starts a turn of its own.
// - `inbox_list`, `inbox_add`, `inbox_update` carry the issue list: a report that came in, what
//   Segno set aside, which lead holds it and whether it is done.
// - `wake_wish` is Roo's wake wish: when Segno next wants to look in, and why.
// - `memory_seed`, `world_fragment`, `sent_messages` are Roo's random-memory.sh, random-world.sh and
//   sent.sh: an old memory, a piece of the world, and what really reached the user.
// - `user_schedule` is Roo's career-schedule.py show, made general: today's and tomorrow's items from every source.
//
// All of them live in the companion's home (harness/companion home.mjs, inbox.mjs, world.mjs,
// schedule.mjs). Those files are staged beside this one because the runtime build cannot reach
// harness/companion.
import { openInbox, INBOX_STATUSES } from "./inbox.mjs";
import { RECORD_KINDS, REPLY_TOOL, SAY_TOOL, commitOwned, landsInside, oldMemorySeed, segnoPaths, record, recordTold, searchSegnoMemory, seedText, sentMessages, sentText, setWakeWish } from "./home.mjs";
import { worldFragment, worldText } from "./world.mjs";
import { showSchedule } from "./schedule.mjs";
import path from "node:path";

const text = (value) => ({ type: "text", text: value });

/** What Segno reads when a turn the user opened ended without a reply (Roo's TELEGRAM_REPLY_REMINDER). */
export const REPLY_REMINDER = "사용자가 답을 기다리고 있어. 방금 하려던 말을 `reply`로 보내.";
/** The hidden message that carries it. */
export const REPLY_REMINDER_TYPE = "rubato-companion.reply-reminder";

/**
 * Roo's reply target, without Telegram: a turn opened by the user's own message waits for a reply.
 * `settled()` answers whether to remind now — once per such turn, only when no reply or say got
 * through; the reminder's own turn belongs to the same wait, so a reply there ends it.
 */
export function createReplyWait() {
  let turn;
  return {
    /** A message entering the session (Pi's `message_start`): the user's own opens a turn to answer. */
    message(message) { if (message?.role === "user") turn = { replied: false, reminded: false }; },
    /** A reply or say that went through answers the turn. */
    toolEnd(event) {
      if (turn && (event?.toolName === REPLY_TOOL || event?.toolName === SAY_TOOL) && event.isError !== true) turn.replied = true;
    },
    settled() {
      if (!turn) return false;
      // Answered, or already reminded once: the wait is over either way.
      if (turn.replied || turn.reminded) { turn = undefined; return false; }
      turn.reminded = true;
      return true;
    },
  };
}

const replyParameters = (what) => ({
  type: "object", additionalProperties: false, required: ["text"],
  properties: { text: { type: "string", minLength: 1, description: what } },
});

function itemLine(item) {
  const who = item.reporter ? ` — ${item.reporter}` : "";
  const lead = item.leadSessionId ? ` · lead ${item.leadSessionId}` : "";
  return `${item.id} [${item.status}] ${item.title}${who}${lead}`;
}

/** `voice`: whether a voice is set, so `say` can speak (none can be yet; Segno then never sees `say`). */
/** The file tools that write a path, and the field that names it. */
const WRITING_TOOLS = Object.freeze({ write: "path", edit: "path" });
/** What Segno reads when a write would go through a link out of its home. */
export const LINKED_WRITE_REFUSAL = "That path reaches outside my home through a link (a repository document under memory/ref, " +
  "linked there for me to read). It is read-only for me: if it is wrong, I tell that repository's lead.";

/**
 * Whether a write tool call would land outside Segno's home through a link inside it (memory/ref
 * links repository documents in to read). Paths outside the home altogether are not this guard's.
 */
export function linkedWriteRefusal(event, { cwd, env = process.env } = {}) {
  const home = segnoPaths(env).home;
  const outward = (target) => {
    if (typeof target !== "string" || !target.trim()) return false;
    const file = path.resolve(cwd || home, target.trim().replace(/^@/, ""));
    const rel = path.relative(home, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return !landsInside(home, file);
  };
  const field = WRITING_TOOLS[event?.toolName];
  if (field) return outward(event.input?.[field]) ? LINKED_WRITE_REFUSAL : undefined;
  // apply_patch names its files on its own marker lines.
  if (event?.toolName === "apply_patch" && typeof event.input?.input === "string") {
    const targets = [...event.input.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]);
    return targets.some(outward) ? LINKED_WRITE_REFUSAL : undefined;
  }
  return undefined;
}

export function createCompanionHomeFactories({ voice = false } = {}) {
  const inbox = () => openInbox();
  return [{
    name: "companion-home",
    factory: (pi) => {
      pi.registerTool({
        name: "segno_record",
        label: "Record",
        exposure: "direct",
        searchKeywords: ["daily", "diary", "note", "mood", "record", "write", "일기", "기록", "메모", "기분"],
        description:
          "Write what lasts: kind 'daily' for the day's facts, decisions and what is still open; " +
          "'diary' for how the day felt, in your own voice, with a short scene as the heading; " +
          "'note' for your own working land, with a name; 'mood' for the one line of mood you fall asleep " +
          "with, which your next waking reads. Each entry is appended under a heading. This tool never " +
          "rewrites; to correct a wrong line, edit that line in the file itself.",
        parameters: {
          type: "object", additionalProperties: false, required: ["kind", "text"],
          properties: {
            kind: { type: "string", enum: [...RECORD_KINDS] },
            text: { type: "string", minLength: 1 },
            heading: { type: "string", description: "A short scene for a diary entry, or a title for the entry." },
            name: { type: "string", description: "For kind 'note' only: the note's name, lowercase with dashes." },
          },
        },
        async execute(_id, params) {
          const written = record(params.kind, params.text, {
            ...(params.heading ? { heading: params.heading } : {}),
            ...(params.name ? { name: params.name } : {}),
          });
          return { content: [text(`Wrote to ${written.file}`)], details: written };
        },
      });

      pi.registerTool({
        name: "segno_commit",
        label: "Commit records",
        exposure: "direct",
        searchKeywords: ["commit", "git", "history", "record", "커밋", "기록", "이력"],
        description:
          "Commit the files you changed in your home to its history: paths inside memory/, notes/ or prompt/, " +
          "relative to your home. Only the named files go in, never a whole folder, because other hands write " +
          "into the same home. Nothing changed means nothing is committed.",
        parameters: {
          type: "object", additionalProperties: false, required: ["paths", "message"],
          properties: {
            paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            message: { type: "string", minLength: 1, description: "One line, e.g. '밤안부: 오늘 일기'." },
          },
        },
        async execute(_id, params) {
          const result = commitOwned(params.paths, params.message);
          return { content: [text(result.committed ? `Committed ${result.commit}: ${result.files.join(", ")}` : "Nothing changed; nothing committed.")],
            details: result };
        },
      });

      pi.registerTool({
        name: "segno_search",
        label: "Search my memory",
        exposure: "direct",
        searchKeywords: ["search", "memory", "recall", "remember", "msearch", "기억", "검색", "찾기"],
        description:
          "Search your own memory — your daily records, diary, canonical pages and resident memory in your home's " +
          "memory/ — the way Roo's msearch does: hybrid meaning and keyword search, newest writes included. Ask with " +
          "the people, events, time and key words you are after, not the user's whole sentence.",
        parameters: {
          type: "object", additionalProperties: false, required: ["query"],
          properties: { query: { type: "string", minLength: 1 } },
        },
        async execute(_id, params) {
          return { content: [text(searchSegnoMemory(params.query))] };
        },
      });

      pi.registerTool({
        name: "memory_seed",
        label: "Old memory",
        exposure: "direct",
        searchKeywords: ["seed", "random", "memory", "walk", "old", "씨앗", "산책", "옛 기억"],
        description:
          "An old memory, at random: one time in three a section from your records older than thirty days or " +
          "from the story half of your canonical pages, otherwise NO_SEED. With walk, no dice: you chose to start " +
          "from an old memory. A seed given out stays out for thirty days.",
        parameters: { type: "object", additionalProperties: false, properties: { walk: { type: "boolean" } } },
        async execute(_id, params) {
          const seed = oldMemorySeed({ walk: params?.walk === true });
          return { content: [text(seedText(seed))], details: seed ?? null };
        },
      });

      pi.registerTool({
        name: "world_fragment",
        label: "World fragment",
        exposure: "direct",
        searchKeywords: ["world", "news", "wikipedia", "hacker news", "random", "세계", "뉴스", "조각"],
        description:
          "One fragment of the world outside: half the time AI news, otherwise the Hacker News front page or a " +
          "random Wikipedia article. A title given out stays out for a week. Empty-handed when nothing could be fetched.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        async execute() {
          const fragment = await worldFragment();
          return { content: [text(worldText(fragment))], details: fragment ?? null };
        },
      });

      pi.registerTool({
        name: REPLY_TOOL,
        label: "Reply",
        exposure: "direct",
        searchKeywords: ["reply", "answer", "say", "message", "tell", "speak", "답", "말하기", "톡", "안부"],
        description:
          "Say something to the user. This is the only way your words reach them: what you write anywhere else, in any turn, " +
          "stays with you. It shows in your thread as your message and the app notifies their phone.",
        parameters: replyParameters("What you say to them, as it should read in your thread."),
        async execute(_id, params) {
          const told = recordTold(params.text, { via: REPLY_TOOL });
          return { content: [text("Sent to the user.")], details: told };
        },
      });

      if (voice) pi.registerTool({
        name: SAY_TOOL,
        label: "Say aloud",
        exposure: "direct",
        searchKeywords: ["say", "voice", "speak", "aloud", "목소리", "음성", "말하기"],
        description: "Say something to the user in your voice. Like reply, it is the only way these words reach them.",
        parameters: replyParameters("What you say aloud to them."),
        async execute(_id, params) {
          const told = recordTold(params.text, { via: SAY_TOOL });
          return { content: [text("Said to the user.")], details: told };
        },
      });

      // Linked repository documents are Segno's to read, never to write (user, 2026-10-21).
      pi.on("tool_call", (event, ctx) => {
        const reason = linkedWriteRefusal(event, { cwd: ctx?.cwd });
        return reason ? { block: true, reason } : undefined;
      });

      // Roo's reminder: a turn the user opened waits for a reply.
      const wait = createReplyWait();
      pi.on("message_start", (event) => wait.message(event?.message));
      pi.on("tool_execution_end", (event) => wait.toolEnd(event));
      pi.on("agent_settled", () => {
        if (!wait.settled()) return;
        pi.sendMessage({ customType: REPLY_REMINDER_TYPE, content: REPLY_REMINDER, display: false }, { deliverAs: "followUp", triggerTurn: true });
      });

      pi.registerTool({
        name: "sent_messages",
        label: "Sent messages",
        exposure: "direct",
        searchKeywords: ["sent", "told", "already", "reply", "보낸", "톡", "꺼낸"],
        description:
          "What actually reached the user from you (reply) in the last days, from the record of what was sent: one " +
          "line each, or each in full when you give a keyword. Check here, not from memory, whether you already " +
          "brought something up.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            days: { type: "integer", minimum: 1, maximum: 60 },
            keyword: { type: "string" },
          },
        },
        async execute(_id, params) {
          const days = params?.days ?? 2;
          const keyword = params?.keyword ?? "";
          const rows = sentMessages({ days, keyword });
          return { content: [text(sentText(rows, { days, keyword }))], details: { rows } };
        },
      });

      pi.registerTool({
        name: "user_schedule",
        label: "Schedule",
        exposure: "direct",
        searchKeywords: ["schedule", "calendar", "deadline", "today", "tomorrow", "일정", "달력", "마감"],
        description:
          "The user's schedule from the sources in your settings (calendar ICS addresses, .ics files, schedule " +
          "files), read where they are: today's and/or tomorrow's items by the real date, and any source that " +
          "could not be read. To add or remove a source, change your settings (schedule.sources).",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { which: { type: "string", enum: ["today", "tomorrow", "both"] } },
        },
        async execute(_id, params) {
          return { content: [text(await showSchedule(params?.which ?? "both"))] };
        },
      });

      pi.registerTool({
        name: "wake_wish",
        label: "Wake wish",
        exposure: "direct",
        searchKeywords: ["wake", "wish", "heartbeat", "reflect", "later", "깨워", "하트비트", "다음에"],
        description:
          "When you next want to look in, and why: minutes from now, HH:MM (the next one; a time already past " +
          "today is tomorrow) or an ISO 8601 time. Until then no heartbeat tick comes; you rest. " +
          "The first tick at or after that time comes with action=reflect and your reason. The user, a lead's " +
          "ending, a greeting, a tick with a greeting catch-up or a schedule nudge, and sleep still wake you. At " +
          "most six hours from now; a later time is cut to six. Setting it again replaces the earlier one.",
        parameters: {
          type: "object", additionalProperties: false, required: ["when", "reason"],
          properties: {
            when: { type: "string", minLength: 1, description: "Minutes, HH:MM or an ISO 8601 time." },
            reason: { type: "string", description: "One line: what you want to look at then." },
          },
        },
        async execute(_id, params) {
          const wish = setWakeWish({ target: params.when, reason: params.reason });
          return { content: [text(`WAKE_WISH_SET wishAt=${wish.wishAt}`)], details: wish };
        },
      });

      pi.registerTool({
        name: "inbox_list",
        label: "Inbox",
        exposure: "direct",
        searchKeywords: ["inbox", "issue", "bug", "report", "ticket", "인박스", "버그", "리포트"],
        description:
          "The issues Segno keeps: bug reports from other chats, things the user handed over, work it " +
          "set aside. 'open' means still somebody's work (open, in-progress, waiting). Each row says " +
          "its id, status, title, reporter and the lead it is linked to.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["open", ...INBOX_STATUSES] },
            source: { type: "string" },
            unlinked: { type: "boolean", description: "Only the items no lead holds yet." },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        async execute(_id, params) {
          const list = inbox();
          try {
            const items = list.list({ ...(params.status ? { status: params.status } : {}),
              ...(params.source ? { source: params.source } : {}), ...(params.unlinked === true ? { unlinked: true } : {}),
              ...(params.limit ? { limit: params.limit } : {}) });
            const counts = list.counts();
            return {
              content: [text(items.length ? `${items.map(itemLine).join("\n")}\n\nopen: ${counts.open ?? 0}` : `Nothing in the inbox yet.\nopen: ${counts.open ?? 0}`)],
              details: { items, counts },
            };
          } finally { list.close(); }
        },
      });

      pi.registerTool({
        name: "inbox_add",
        label: "Add to inbox",
        exposure: "direct",
        searchKeywords: ["inbox", "issue", "bug", "report", "add", "인박스", "추가"],
        description:
          "Put one issue in the inbox so it does not get lost: what it is, as a short title, and the " +
          "details. The person's own words go in the body as they said them.",
        parameters: {
          type: "object", additionalProperties: false, required: ["title"],
          properties: {
            title: { type: "string", minLength: 1 },
            body: { type: "string" },
            reporter: { type: "string" },
            status: { type: "string", enum: [...INBOX_STATUSES] },
          },
        },
        async execute(_id, params) {
          const list = inbox();
          try {
            const { item, duplicate } = list.add({ title: params.title, body: params.body ?? "", source: "agent",
              reporter: params.reporter, status: params.status ?? "open" });
            return { content: [text(`${duplicate ? "Already there" : "Added"}: ${itemLine(item)}`)], details: { item, duplicate } };
          } finally { list.close(); }
        },
      });

      pi.registerTool({
        name: "inbox_update",
        label: "Update inbox",
        exposure: "direct",
        searchKeywords: ["inbox", "issue", "status", "link", "close", "인박스", "상태", "닫기"],
        description:
          "Move one issue: its status (open, in-progress, waiting, done, dropped), the lead conversation " +
          "it is handed to, or a line about what happened. Closing is status done or dropped.",
        parameters: {
          type: "object", additionalProperties: false, required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
            status: { type: "string", enum: [...INBOX_STATUSES] },
            leadSessionId: { type: "string" },
            note: { type: "string" },
            title: { type: "string" },
          },
        },
        async execute(_id, params) {
          const list = inbox();
          try {
            const item = list.update(params.id, {
              ...(params.status ? { status: params.status } : {}),
              ...(params.leadSessionId ? { leadSessionId: params.leadSessionId } : {}),
              ...(params.note ? { note: params.note } : {}),
              ...(params.title ? { title: params.title } : {}),
            });
            return { content: [text(itemLine(item))], details: { item } };
          } finally { list.close(); }
        },
      });
    },
  }];
}

export default createCompanionHomeFactories;
