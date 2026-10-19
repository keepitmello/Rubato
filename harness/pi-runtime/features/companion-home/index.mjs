// Segno's own memory, in its own words: two records, its inbox, and the prompt files it owns.
//
// - `segno_record` writes the daily (facts, decisions, what is still open), the diary (feelings and
//   memorable exchanges, in Segno's voice) or a working note.
// - `inbox_list`, `inbox_add`, `inbox_update` carry the issue list: a report from another chat in
//   Telegram, what Segno set aside, which lead holds it and whether it is done.
// - `segno_persona` reads the four files that say who Segno is — the person's own copy, the Rubato
//   default it was copied from, and whether that default moved — and saves the person's version.
//
// All of it lives in the companion's home (harness/companion/home.mjs, inbox.mjs, companion.mjs).
// Those files are staged beside this one because the runtime build cannot reach harness/companion,
// and they import nothing local for the same reason.
import { homedir } from "node:os";
import { join } from "node:path";

import { SEEDED_PIECES, basePiecePath, personalPiecePath, readPieces, writePiece } from "./companion.mjs";
import { openInbox, INBOX_STATUSES } from "./inbox.mjs";
import { RECORD_KINDS, record } from "./home.mjs";

const text = (value) => ({ type: "text", text: value });

/**
 * Where Rubato's default prompt pieces live. The same rule as rubato-pi's `rolePromptsRoot` followed
 * by `companion` (harness/rubato-pi/src/system-prompt.mjs); repeated here because a staged feature
 * cannot reach that file. test/persona-tools.test.mjs holds the two together.
 */
export function companionDefaultsDir(env = process.env) {
  return join(env.RUBATO_PROMPTS_DIR || join(homedir(), ".agents", "rubato"), "companion");
}

function personaEntry(piece) {
  const origin = piece.baseUnknown ? "base unknown (set up before Rubato kept a copy)"
    : piece.defaultChanged ? "Rubato's default changed since this copy"
      : "copied from Rubato's current default";
  return [
    `## ${piece.id} — ${origin}`,
    `--- mine ---\n${piece.personalText ?? "(no copy yet: this file follows Rubato's default)"}`,
    `--- Rubato default ---\n${piece.defaultText}`,
    ...(piece.baseText === undefined ? [] : [`--- base (what it was copied from) ---\n${piece.baseText}`]),
  ].join("\n");
}

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
        name: "segno_persona",
        label: "Persona",
        exposure: "direct",
        searchKeywords: ["persona", "prompt", "soul", "identity", "preamble", "about you", "default", "프롬프트", "성격", "기본값"],
        description:
          "The four prompt files that say who you are (preamble, soul, identity, user): the person's own " +
          "copy, the Rubato default it was copied from and whether that default moved. action 'list' " +
          "reads all four with their texts. action 'write' saves the person's version of one — only " +
          "after they said which changes to take; pass accepted=true then, so Rubato knows you saw this " +
          "default and does not ask again.",
        parameters: {
          type: "object", additionalProperties: false, required: ["action"],
          properties: {
            action: { type: "string", enum: ["list", "write"] },
            piece: { type: "string", enum: [...SEEDED_PIECES], description: "For action 'write': which file." },
            text: { type: "string", minLength: 1, description: "For action 'write': the whole file, as it should read." },
            accepted: { type: "boolean", description: "The person took the default changes you brought them; the base moves to the new default." },
          },
        },
        async execute(_id, params) {
          const env = process.env;
          const defaultsDir = companionDefaultsDir(env);
          if (params.action === "list") {
            const pieces = readPieces({ defaultsDir, env }).filter((piece) => SEEDED_PIECES.includes(piece.id));
            return {
              content: [text(pieces.map(personaEntry).join("\n\n"))],
              details: { pieces: pieces.map((piece) => ({ id: piece.id, baseUnknown: piece.baseUnknown === true,
                defaultChanged: piece.defaultChanged === true, reviewDue: piece.reviewDue === true })) },
            };
          }
          if (!params.piece || typeof params.text !== "string")
            throw new Error("writing a persona file needs 'piece' and 'text'");
          if (!SEEDED_PIECES.includes(params.piece)) throw new Error(`${params.piece} is Rubato's, not yours to write`);
          writePiece(params.piece, params.text, { defaultsDir, env, accepted: params.accepted === true });
          const file = params.accepted === true ? basePiecePath(env, params.piece) : personalPiecePath(env, params.piece);
          return {
            content: [text(`Saved ${params.piece}.${params.accepted === true ? " The base now names this default." : ""} ${file}`)],
            details: { piece: params.piece, accepted: params.accepted === true, file },
          };
        },
      });

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
