// Segno's own memory, in its own words: two records and its inbox.
//
// - `segno_record` writes the daily (facts, decisions, what is still open), the diary (feelings and
//   memorable exchanges, in Segno's voice) or a working note.
// - `inbox_list`, `inbox_add`, `inbox_update` carry the issue list: a report from another chat in
//   Telegram, what Segno set aside, which lead holds it and whether it is done.
// - `wake_wish` is Roo's wake wish: when Segno next wants to look in, and why.
//
// Both live in the companion's home (harness/companion/home.mjs, inbox.mjs). Those two files are
// staged beside this one because the runtime build cannot reach harness/companion, and they import
// nothing local for the same reason.
import { openInbox, INBOX_STATUSES } from "./inbox.mjs";
import { RECORD_KINDS, record, setWakeWish } from "./home.mjs";

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
        searchKeywords: ["daily", "diary", "note", "record", "write", "일기", "기록", "메모"],
        description:
          "Write what lasts: kind 'daily' for the day's facts, decisions and what is still open; " +
          "'diary' for how the day felt, in your own voice, with a short scene as the heading; " +
          "'note' for your own working land, with a name. Each entry is appended under a heading; " +
          "nothing already written is rewritten.",
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
        name: "wake_wish",
        label: "Wake wish",
        exposure: "direct",
        searchKeywords: ["wake", "wish", "heartbeat", "reflect", "later", "깨워", "하트비트", "다음에"],
        description:
          "When you next want to look in, and why: minutes from now, HH:MM (the next one; a time already past " +
          "today is tomorrow) or an ISO 8601 time. Until then no heartbeat tick comes; you rest. " +
          "The first tick at or after that time comes with action=reflect and your reason. The user, a lead's " +
          "ending, the daily report and sleep still wake you. At most six hours from now; a later time is cut to " +
          "six. Setting it again replaces the earlier one.",
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
