// Segno's own memory, in its own words, and the things its own time reaches for.
//
// - `segno_record` writes the daily (facts, decisions, what is still open), the diary (feelings and
//   memorable exchanges, in Segno's voice), a working note, or the mood it falls asleep with.
// - `segno_search` searches Segno's own memory/ with msearch (Roo's msearch.sh over Roo's memory/).
// - `segno_commit` commits the record files Segno changed to its home's history (Roo commit-owned.sh).
// - `inbox_list`, `inbox_add`, `inbox_update` carry the issue list: a report from another chat in
//   Telegram, what Segno set aside, which lead holds it and whether it is done.
// - `wake_wish` is Roo's wake wish: when Segno next wants to look in, and why.
// - `memory_seed`, `world_fragment`, `sent_messages` are Roo's random-memory.sh, random-world.sh and
//   sent.sh: an old memory, a piece of the world, and what really reached the user.
// - `career_schedule` is Roo's career-schedule.py show: today's and tomorrow's part of the schedule.
//
// All of them live in the companion's home (harness/companion home.mjs, inbox.mjs, world.mjs,
// career.mjs). Those files are staged beside this one because the runtime build cannot reach
// harness/companion.
import { openInbox, INBOX_STATUSES } from "./inbox.mjs";
import { RECORD_KINDS, commitOwned, oldMemorySeed, record, searchSegnoMemory, seedText, sentMessages, sentText, setWakeWish } from "./home.mjs";
import { worldFragment, worldText } from "./world.mjs";
import { showSchedule } from "./career.mjs";

const text = (value) => ({ type: "text", text: value });

function itemLine(item) {
  const who = item.reporter ? ` — ${item.reporter}` : "";
  const lead = item.leadSessionId ? ` · lead ${item.leadSessionId}` : "";
  return `${item.id} [${item.status}] ${item.title}${who}${lead}`;
}

export function createCompanionHomeFactories() {
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
        name: "sent_messages",
        label: "Sent messages",
        exposure: "direct",
        searchKeywords: ["sent", "telegram", "already", "told", "보낸", "톡", "꺼낸"],
        description:
          "What actually reached the user's Telegram from you in the last days, from the messenger's record: one " +
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
        name: "career_schedule",
        label: "Schedule",
        exposure: "direct",
        searchKeywords: ["schedule", "deadline", "career", "today", "tomorrow", "일정", "마감", "일정표"],
        description:
          "The user's deadline schedule from Settings › Companion, read where it is: today's and/or tomorrow's " +
          "section by the real date, with when the schedule was generated. A schedule lists only what is not " +
          "handed in yet.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { which: { type: "string", enum: ["today", "tomorrow", "both"] } },
        },
        async execute(_id, params) {
          return { content: [text(showSchedule(params?.which ?? "both"))] };
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
          "ending, a greeting, a tick with a greeting catch-up or a deadline nudge, and sleep still wake you. At " +
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
