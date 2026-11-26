// Original lines attached to an incoming message that talks about money, people or who did what, so the
// companion answers from the room's own words and not from a summary or a memory of them.
//
// - Only Segno's session (the default companion) and only two kinds of incoming words: the user's own
//   app message and the "원문:" lines of an inbox wake. Other conversations, heartbeats and notices get nothing.
// - A message that carries no money, no known account holder and no "who did it" gets nothing.
// - The search reads the local Telegram store (the one `tg recall` reads) directly, over the last 30 days,
//   and scores each message by the amounts and rare words it shares with the incoming one. At most five
//   lines come back; with nothing worth showing, nothing is attached, and not a "found nothing" note either.
// - The same original is not shown twice within 30 minutes, so a topic that goes on gets its lines once.
// - Nothing is blocked and nothing is written into the transcript: the lines ride along in the context
//   the model reads, after the message they belong to, and stay there for the rest of the session.
import { homedir } from "node:os";
import path from "node:path";

export const CLUE_TYPE = "rubato-companion.source-clues";
export const CLUE_HEADER = "원문 단서 — 이건 찾아 둔 원문이야. 답은 여기와 이번 턴 조회로.";
export const CLUE_LIMIT = 5;
const WINDOW_DAYS = 30;
const SEEN_MS = 30 * 60_000;
const TOPIC_MS = 20 * 60_000;
const BUDGET_MS = 1000;
const MEMO_LIMIT = 200;

const MONEY_WORDS = /출금|입금|동결|잔액|잔고|수수료|송금|이체|정산|환전|충전|계좌|통장|카카오페이|카뱅|카페|토스|핑|통협|묶[인여이]|빼[둔둠놓]|돈|금액|얼마/u;
const WHO_DID = /누가|누구|(?:이|가|은|는)\s*(?:한|했|시킨|시켰|뺀|뺐|보낸|보냈|넣은|넣었|옮긴|옮겼)|한\s*(?:게|거|건|것)\s*아니|업체가|장주|실장이/u;
const BANKS = "카뱅|카카오뱅크|카카오페이|카페|토스|기업|우리|대구|농협|국민|신한|하나|새마을|부산|경남|광주|전북|제주|수협|우체국|케이뱅크|SC";
const HOLDER = new RegExp(`(?<![가-힣])([가-힣]{3})\\s*(?:${BANKS})(?![가-힣])`, "gu");
const JOSA = /(?:에서는|에서|으로는|으로|이라고|라고|이랑|한테|에게|까지|부터|처럼|보다|이나|이가|입니다|인데|이고|이야|이지|인가|이다|은|는|이|가|을|를|의|에|도|로|과|와|만|랑|야)$/u;
// A row that shares only everyday words with the message is chatter; it has to share one of these, an amount,
// or an adjacent pair before it counts.
const ANCHOR = new RegExp(`${BANKS}|장주|장업체|실장|업체`, "u");
const ALIASES = Object.freeze({ 카페: ["카카오페이"], 카카오페이: ["카페"], 카뱅: ["카카오뱅크"], 카카오뱅크: ["카뱅"] });

/** The size of an amount word: 400만 → 4,000,000. Plain numbers must carry a comma, a unit or five digits. */
export function amountsOf(text) {
  const out = [];
  const body = String(text);
  const pattern = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(억|만\s*원|만|천\s*원|천|원)?/gu;
  for (const match of body.matchAll(pattern)) {
    const before = body[match.index - 1], after = body[match.index + match[0].length];
    if (before === ":" || before === "/" || before === "." || before === "#" || /[:/]/.test(after ?? "")) continue;
    const digits = match[1].replace(/,/g, "");
    const unit = match[2]?.replace(/\s+/g, "") ?? "";
    if (!unit && !match[1].includes(",") && digits.length < 5) continue;
    if (/^(?:시|분|일|월|년|번|건|개|명|%)/u.test(body.slice(match.index + match[0].length).trim())) continue;
    const scale = unit.startsWith("억") ? 1e8 : unit.startsWith("만") ? 1e4 : unit.startsWith("천") ? 1e3 : 1;
    const value = Number(digits) * scale;
    if (Number.isFinite(value) && value >= 1000) out.push(value);
  }
  return [...new Set(out)];
}

const compact = (text) => String(text).replace(/\s+/g, "");
/** The word and what is left when a particle is cut: 카카오페이가 → 카카오페이가, 카카오페이, 카카오페 (a final 이 may belong to the word). */
const stems = (word) => {
  const out = new Set([word]);
  const long = word.replace(JOSA, "");
  const short = word.replace(/[은는이가을를의에도로과와만랑야]$/u, "");
  for (const cut of [long, short]) if (cut.length >= 2) out.add(cut);
  return [...out];
};
const stem = (word) => stems(word).at(-1) ?? word;
const near = (a, b) => Math.abs(a - b) / Math.max(a, b) <= 0.02;

/** The words worth looking up: stems of two or more letters, plus adjacent pairs written without the space. */
export function wordsOf(text) {
  const raw = String(text).replace(/\d[\d,.]*\s*(?:억|만|천|원)?/gu, " ").split(/[^가-힣A-Za-z]+/u).filter(Boolean);
  const words = new Set();
  const pairs = new Set();
  raw.forEach((word, i) => {
    for (const variant of stems(word)) {
      if (variant.length < 2) continue;
      words.add(variant);
      for (const alias of ALIASES[variant] ?? []) words.add(alias);
    }
    const next = raw[i + 1];
    // "장 업체가" is looked up as 장업체: a one-letter word only means something beside its neighbour.
    if (next && /^(?:업체|주|링)/u.test(next)) pairs.add(stem(word + next));
  });
  return { words: [...words], pairs: [...pairs] };
}

/** Whether the message is about money, a known account holder or who did what. */
export function needsSource(text, holders = new Set()) {
  const body = String(text);
  if (amountsOf(body).length || MONEY_WORDS.test(body) || WHO_DID.test(body)) return true;
  for (const name of holders) if (body.includes(name)) return true;
  return false;
}

const kst = (seconds) => {
  const d = new Date(seconds * 1000 + 9 * 3600_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

function bestLine(text, cues) {
  const lines = String(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let best = lines[0] ?? "";
  let top = -1;
  for (const line of lines) {
    const flat = compact(line);
    let hits = cues.words.filter((word) => flat.includes(word)).length + cues.pairs.filter((pair) => flat.includes(pair)).length * 2;
    const values = amountsOf(line);
    hits += cues.amounts.filter((a) => values.some((v) => near(v, a))).length * 2;
    if (hits > top) { top = hits; best = line; }
  }
  return best.length > 160 ? `${best.slice(0, 159)}…` : best;
}

/**
 * The rows of `pool` that share the most with the incoming words, best first. An amount counts when it is the
 * same or within 2% of one in the message (400만 and 4,051,000 meet). A word weighs by how rare it is in the pool;
 * a word in more than 4% of the pool weighs nothing. A row needs an amount, a pair, an account or vendor word, or a
 * known account holder. Rows that repeat what a better row already says (same amounts, same sender) are skipped.
 */
export function rankPool(pool, cues, { limit = CLUE_LIMIT, holders = new Set(), skip = () => false } = {}) {
  const flats = pool.map((row) => compact(row.text));
  const size = pool.length || 1;
  const weigh = (needle) => {
    const df = flats.reduce((n, flat) => n + (flat.includes(needle) ? 1 : 0), 0);
    return df === 0 || df / size > 0.04 ? 0 : Math.log(size / df);
  };
  const wordWeight = new Map(cues.words.map((word) => [word, weigh(word)]));
  const pairWeight = new Map(cues.pairs.map((pair) => [pair, weigh(pair)]));
  const scored = [];
  pool.forEach((row, i) => {
    const flat = flats[i];
    const values = cues.amounts.length ? amountsOf(row.text) : [];
    let score = 0;
    let anchored = false;
    let amountHit = false;
    for (const a of cues.amounts) if (values.some((v) => near(v, a))) { anchored = amountHit = true; score += 4; }
    for (const [pair, weight] of pairWeight) if (weight && flat.includes(pair)) { anchored = true; score += 2 + weight; }
    const hit = cues.words.filter((word) => wordWeight.get(word) && flat.includes(word));
    const distinct = hit.filter((word) => !hit.some((other) => other !== word && other.includes(word)));
    for (const word of hit) {
      // 카카오페 inside 카카오페이: only the longer word counts.
      if (hit.some((other) => other !== word && other.includes(word))) continue;
      const weight = wordWeight.get(word);
      score += weight * (cues.topic?.has(word) ? 0.5 : 1);
      if (!cues.topic?.has(word) && (ANCHOR.test(word) || holders.has(word))) anchored = true;
    }
    // Asked about an amount, a row without it needs two different words to count.
    if (cues.amounts.length && !amountHit && distinct.length < 2) return;
    // A statement of money (an amount, an account holder) beats a question about it.
    if (values.length || amountsOf(row.text).length) score += 1.5;
    if ([...holders].some((name) => row.text.includes(name))) score += 1;
    if (/[?？]\s*$|(?:까요|나요|ㄹ까|세요)\s*$/u.test(row.text.trim())) score -= 2;
    if (row.text.length > 400) score -= 1.5;
    if (anchored && score >= 4) scored.push({ row, score });
  });
  scored.sort((a, b) => b.score - a.score || b.row.date - a.row.date);
  const picked = [];
  const shape = (row) => `${row.sender_name}|${amountsOf(bestLine(row.text, cues)).join(",")}`;
  const shapes = new Set();
  // Rows far below the best one are filler, even when the best one was shown already.
  const floor = (scored[0]?.score ?? 0) * 0.6;
  for (const { row, score } of scored) {
    if (score < floor) break;
    const key = shape(row);
    if (!key.endsWith("|") && shapes.has(key)) continue;
    shapes.add(key);
    if (skip(row)) continue;
    picked.push(row);
    if (picked.length >= limit) break;
  }
  return picked;
}

export const clueLine = (row, cues) =>
  `tg:${row.chat_id}:${row.msg_id} · ${kst(row.date)} · ${row.out ? "우용(내 계정)" : row.sender_name || "?"} · ${bestLine(row.text, cues).replace(/\s+/g, " ")}`;

export const clueText = (rows, cues) => rows.length ? `${CLUE_HEADER}\n${rows.map((row) => clueLine(row, cues)).join("\n")}` : "";

export function tgDbPath(env = process.env) {
  return env.RUBATO_COMPANION_TG_DB || path.join(env.HOME || homedir(), ".local", "state", "tg-mtproto", "tg.db");
}

async function openStore(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

const textOf = (message) => typeof message?.content === "string" ? message.content
  : Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";

/** What a message says in the user's or the rooms' own words, or undefined when it is neither. */
export function incomingWords(message) {
  if (message?.role === "user") {
    if (message.rubatoAppText === null) return undefined;
    const text = typeof message.rubatoAppText === "string" ? message.rubatoAppText : textOf(message);
    if (/^(?:\[voice\] |<skill name=|<system>)/u.test(text)) return undefined;
    return text.replace(/\n\n<t3_context version="1">\n[\s\S]*\n<\/t3_context>\s*$/u, "").trim() || undefined;
  }
  if (message?.role === "custom" && message.customType === "rubato-session-message" && message.details?.kind === "wake" && message.details?.what === "inbox") {
    const lines = textOf(message).split("\n").filter((line) => /^원문:/u.test(line)).map((line) => line.replace(/^원문:\s*/u, ""));
    return lines.join("\n").trim() || undefined;
  }
  return undefined;
}

const keyOf = (message) => `${message.role}:${message.timestamp ?? ""}:${textOf(message).length}:${textOf(message).slice(0, 80)}`;
const isIncoming = (message) => message?.role === "user" || (message?.role === "custom" && message.customType === "rubato-session-message");

export function installSourceClues(pi, { env = process.env, now = Date.now, open = openStore } = {}) {
  if ((env.RUBATO_COMPANION_ID || "segno") !== "segno") return;
  const memo = new Map();
  const seen = new Map();
  let topic = { at: 0, words: new Set() };
  let holders = { at: 0, names: new Set() };

  async function find(words) {
    const started = now();
    let db;
    try { db = await open(tgDbPath(env)); } catch { return ""; }
    try {
      const since = Math.floor(now() / 1000) - WINDOW_DAYS * 86400;
      const pool = db.prepare("select chat_id, msg_id, date, out, sender_name, text from messages where date >= ? and deleted_at is null and text <> ''").all(since);
      if (now() - holders.at > 10 * 60_000) {
        const names = new Set();
        for (const row of pool) for (const match of row.text.matchAll(HOLDER)) names.add(match[1]);
        holders = { at: now(), names };
      }
      if (!needsSource(words, holders.names)) return "";
      const { words: terms, pairs } = wordsOf(words);
      const cues = { amounts: amountsOf(words), words: [...terms], pairs, topic: new Set() };
      if (now() - topic.at <= TOPIC_MS) for (const word of topic.words) if (!terms.includes(word) && !pairs.includes(word)) { cues.words.push(word); cues.topic.add(word); }
      topic = { at: now(), words: new Set([...terms, ...pairs]) };
      for (const [id, at] of seen) if (now() - at > SEEN_MS) seen.delete(id);
      const rows = rankPool(pool, cues, { holders: holders.names, skip: (row) => seen.has(`${row.chat_id}:${row.msg_id}`) });
      if (!rows.length || now() - started > BUDGET_MS) return "";
      for (const row of rows) seen.set(`${row.chat_id}:${row.msg_id}`, now());
      return clueText(rows, cues);
    } catch {
      return "";
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  pi.on("context", async (event) => {
    const messages = event.messages;
    const lastAssistant = messages.findLastIndex((message) => message?.role === "assistant");
    const out = [];
    let added = false;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      out.push(message);
      if (!isIncoming(message)) continue;
      const key = keyOf(message);
      let text = memo.get(key);
      if (text === undefined && i > lastAssistant) {
        const words = incomingWords(message);
        text = words ? await find(words) : "";
        memo.set(key, text);
        if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value);
      }
      if (!text) continue;
      out.push({ role: "custom", customType: CLUE_TYPE, display: false, content: [{ type: "text", text }], timestamp: message.timestamp });
      added = true;
    }
    return added ? { messages: out } : undefined;
  });
}
