// Not wired: the user turned the reply checks off on 11-22 ("나랑은 얘기 엄청많이하는데 거기에 다 검사기
// 거는 건 좀 말 안되는거같은데" → "응 끄자"), so no reply runs them. Commit af0754449 shows how the reply
// tool called checkReply.
//
// The checks on the companion's `reply`: what reaches the user answers what they said and claims only
// what the companion saw. User, 2026-11-22: "구조적으로 동문서답 자체가 불가능하게 하라고", "제발 동문서답
// 하지 말라고 내가 20번은 말하지않았냐", then (13:0x) "근거 대조도 붙히자 못 지어내게".
//
// Before `reply` delivers, one model call (Claude Sonnet; Haiku when Sonnet cannot answer) reads the
// draft with:
// - the user's lines since the companion's last reply that answered them, and a few turns before
//   (the answer check: only when such lines wait);
// - the evidence from this context window that bears on the draft: tool results, lead and session
//   messages, wakes with their inbox items, the user's own messages (the grounding check: every reply,
//   proactive ones and follow-ups included);
// - the recent turns, to find a "확실해?" the draft answers by changing its claim (the flip check).
// The model only maps: each point to the draft line that answers it, each factual sentence to the
// evidence that supports it, a doubting line to whether the draft changes the claim. Code decides:
// a point with no answering line, a first line that answers none, a sentence with no evidence, or a
// changed claim with no tool result since the doubt is refused. A refusal is thrown back to the
// companion naming what failed, and nothing is delivered.
//
// There is no switch to skip it. When no model answers (every model on both Anthropic accounts down
// or out of quota), the reply is refused with that said: a silent pass would make the check optional
// exactly when it matters least to notice.
//
// Pure parts first (conversation, pendingAsk, evidenceOf, pickEvidence, checkPrompt, parseVerdict,
// refusalText), the model call at the bottom (checkReply).

export const ANSWER_CHECK_TOOL_NAMES = Object.freeze(["reply", "say"]);
/**
 * The models tried, tier by tier; inside a tier the two accounts go in random order (user, 11-22, for
 * the Telegram check: "메인서브 중에 쿼터 남은 계정으로 섞어서 랜덤으로"), and one out of quota or
 * failing hands over to the next. Sonnet first: on the 11-22 cases Haiku passed the reply that
 * answered "응, 이상하게 한 거 맞아" and then listed five other mistakes, three runs out of three;
 * Sonnet refused it every time, about a second slower. Haiku is the last tier, so the check still
 * runs when Sonnet's quota is gone on both accounts.
 */
export const ANSWER_CHECK_MODELS = Object.freeze([
  Object.freeze([Object.freeze({ provider: "anthropic", id: "claude-sonnet-5-5" }), Object.freeze({ provider: "anthropic", id: "claude-sonnet-5-5-sub" })]),
  Object.freeze([Object.freeze({ provider: "anthropic", id: "claude-haiku-5-5" }), Object.freeze({ provider: "anthropic", id: "claude-haiku-5-5-sub" })]),
]);
export const ANSWER_CHECK_TIMEOUT_MS = 30_000;
/** At most this many of the user's waiting lines, the newest kept. */
export const PENDING_MAX_LINES = 20;
/** Turns before the waiting lines, for what "그거" points at. */
export const CONTEXT_TURNS = 6;
/** Waiting lines older than this no longer hold a reply back. */
export const PENDING_MAX_AGE_MS = 12 * 60 * 60_000;
const LINE_CHARS = 700;
/** The user's waiting lines get more room: a pasted exchange with the question at its end. */
const USER_LINE_CHARS = 4000;
/** A first line this short opens the answer below it rather than standing in for it. */
export const LEAD_IN_CHARS = 20;
/**
 * The line the app sends when it restarted in the middle of a turn (t3-integration rpc-connection.mjs
 * T3_RESTART_CONTINUE_TEXT; this file travels into the runtime build alone, so the value is here and
 * the test holds the two equal). It is not the user talking.
 */
export const RESTART_CONTINUE_TEXT = "Continue where you left off.";
/**
 * The app's continuation as stored: marked `rubatoOrigin: "restart"` (the engine keeps who made an
 * input); older entries carry no mark and were never typed in the app (`rubatoAppText`), so their
 * opening words tell. The app adds a note after those words, so equality never matched one.
 */
export const isRestartContinuation = (message) => message?.rubatoOrigin === "restart"
  || (message?.rubatoOrigin === undefined && typeof message?.rubatoAppText !== "string" && message?.rubatoAppText !== true
    && textOf(message?.content).trimStart().startsWith(RESTART_CONTINUE_TEXT));

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => part?.type === "text" ? part.text ?? ""
    : part?.type === "image" ? "[사진]" : "").join("") : "";
const atOf = (value) => { const at = typeof value === "number" ? value : Date.parse(value ?? ""); return Number.isFinite(at) ? at : undefined; };

/**
 * One session branch (entries, or the in-memory messages) as the chat between the user and the
 * companion: { who: "user" | "me" | "event", text, at, index, cleared? } (index: its place in `entries`). "me" is a reply that went through;
 * `cleared` is false when its check passed only on a promise to look, so the user's question still waits.
 * "event" is anything else that woke the companion (a wake, a lead's notice, another conversation).
 * A line heard on a call ("[voice] ") is answered on the call and is not part of this chat.
 */
export function conversation(entries) {
  const calls = new Map();
  const out = [];
  const list = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    const message = entry?.type === "message" ? entry.message : entry?.type === "custom_message" ? { ...entry, role: "custom" } : entry;
    if (!message || typeof message !== "object") continue;
    const at = atOf(message.timestamp ?? entry?.timestamp);
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text && !text.startsWith("[voice] ") && !isRestartContinuation(message)) out.push({ who: "user", text, at, index });
    } else if (message.role === "custom") {
      const details = message.details ?? {};
      if (message.customType === "rubato-session-message" && details.kind === "channel" && details.from?.isUser === true) {
        const text = String(details.text ?? "").trim();
        if (text) out.push({ who: "user", text, at, index });
      } else if (message.customType === "rubato-session-message") out.push({ who: "event", text: details.kind ?? "", at, index });
    } else if (message.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && ANSWER_CHECK_TOOL_NAMES.includes(part.name)) calls.set(part.id, part.arguments ?? {});
      }
    } else if (message.role === "toolResult" && ANSWER_CHECK_TOOL_NAMES.includes(message.toolName) && calls.has(message.toolCallId)) {
      const args = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (message.isError === true) continue;
      const text = String(args.text || args.voice_text || "").trim();
      out.push({ who: "me", text, at, index, cleared: message.details?.answerCheck?.cleared !== false });
    }
  }
  return out;
}

/**
 * What the draft has to answer, or undefined when nothing waits (a proactive message):
 * `lines` are the user's lines since the last reply that cleared them; `sent` are replies already
 * sent after the first of them that did not clear them (a "볼게" before the real answer);
 * `context` is the few turns before. Pure.
 */
export function pendingAsk(entries, { now = Date.now() } = {}) {
  const chat = conversation(entries).filter((item) => item.who !== "event");
  let start = chat.length;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].who === "me" && chat[i].cleared) break;
    start = i;
  }
  const stretch = chat.slice(start);
  const lines = stretch.filter((item) => item.who === "user").slice(-PENDING_MAX_LINES);
  if (!lines.length) return undefined;
  const newest = lines.at(-1).at;
  if (newest !== undefined && now - newest > PENDING_MAX_AGE_MS) return undefined;
  const firstIndex = stretch.indexOf(lines[0]);
  const sent = stretch.slice(firstIndex).filter((item) => item.who === "me");
  const context = chat.slice(0, start).slice(-CONTEXT_TURNS);
  return { lines, sent, context };
}

/** The recent turns (the user and the companion's sent replies) the flip check reads. */
export const RECENT_TURNS = 10;
/** Room for the evidence in one check, and for one piece of it. */
export const EVIDENCE_CHARS = 32_000;
const EVIDENCE_ITEM_CHARS = 3_000;
/** The newest pieces of evidence always go in, whatever words they share with the draft. */
const RECENT_EVIDENCE = 16;
/**
 * Tool results that are the companion's own words, not something it saw: what it said, wrote down or
 * looked up of its own sending. A claim repeated from them is still unsupported.
 */
export const OWN_WORD_TOOLS = Object.freeze(new Set(["reply", "say", "telegram_send", "sent_messages", "companion_record",
  "segno_record", "companion_commit", "segno_commit", "notes_write_file", "notes_append_to_file", "wake_wish"]));

/** Tools whose call is something the companion did or said outward, and the words that show it. */
const DID_TOOLS = new Map([
  ["session_send", (args) => `${args.sessionId ?? ""}에 보냄: ${args.text ?? ""}`],
  ["session_create", (args) => `리드 띄움 "${args.title ?? ""}": ${args.text ?? ""}`],
  ["session_stop", (args) => `리드 멈춤: ${args.sessionId ?? ""}`],
  ["bash", (args) => `실행: ${args.command ?? ""}`],
  ["inbox_add", (args) => `인박스에 넣음: ${args.title ?? ""} ${args.body ?? ""}`],
  ["inbox_update", (args) => `인박스 바꿈: ${JSON.stringify(args)}`],
  ["schedule", (args) => `예약: ${JSON.stringify(args)}`],
]);

/** Where this context window starts: the entry the last compaction kept first, else the beginning. */
function windowStart(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type !== "compaction") continue;
    const kept = list[i].firstKeptEntryId;
    const at = kept ? list.findIndex((entry) => entry?.id === kept) : -1;
    return at >= 0 && at < i ? at : i;
  }
  return 0;
}

/**
 * What the companion saw in this context window, oldest first: { index, kind, label, text, at }.
 * kind: "tool" (a tool result, with the call that made it), "did" (what the companion itself sent or
 * started: the words of a session_send, a session_create, a command it ran; evidence of what it did
 * and said, never of the world), "message" (a lead, another conversation, a wake with its inbox items),
 * "user", "summary" (a compaction's summary). Its replies, records and notes (OWN_WORD_TOOLS) and what
 * it wrote between tools are left out. Pure.
 */
export function evidenceOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const calls = new Map();
  const out = [];
  for (let index = windowStart(list); index < list.length; index++) {
    const entry = list[index];
    const message = entry?.type === "message" ? entry.message : undefined;
    const at = atOf(message?.timestamp ?? entry?.timestamp);
    if (entry?.type === "compaction" && typeof entry.summary === "string") {
      out.push({ index, kind: "summary", label: "요약", text: entry.summary, at });
    } else if (entry?.type === "custom_message" && entry.customType === "rubato-session-message") {
      const details = entry.details ?? {};
      const text = String(details.text ?? textOf(entry.content) ?? "").trim();
      if (!text) continue;
      const user = details.kind === "channel" && details.from?.isUser === true;
      out.push({ index, kind: user ? "user" : "message", label: user ? "사용자" : `${details.kind ?? "message"}${details.from?.title ? ` · ${details.from.title}` : ""}`, text, at });
    } else if (message?.role === "user") {
      const text = textOf(message.content).trim();
      if (text && !isRestartContinuation(message)) out.push({ index, kind: "user", label: "사용자", text, at });
    } else if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
      }
    } else if (message?.role === "toolResult" && !OWN_WORD_TOOLS.has(message.toolName)) {
      const call = calls.get(message.toolCallId);
      const name = message.toolName ?? "tool";
      // What it sent or ran, in full, as its own act: a brief to a lead or a message it sent is evidence
      // that it said so, not that what it said is true.
      const said = call && DID_TOOLS.has(name) ? clip(DID_TOOLS.get(name)(call.args), 1500) : "";
      if (said && !message.isError) out.push({ index, kind: "did", label: `내가 한 일 · ${name}`, text: said, at });
      const text = textOf(message.content).trim();
      if (!text) continue;
      const args = call ? clip(JSON.stringify(call.args), 200) : "";
      out.push({ index, kind: "tool", label: `${name}${message.isError ? " (error)" : ""}${args ? ` ${args}` : ""}`, text, at });
    }
  }
  return out;
}

/** The words a text is matched on: words and numbers, and the first two and three letters of a Korean word. */
export function terms(text) {
  const out = new Set();
  // Korean runs apart from Latin letters and digits, so "250,000원" and "API로" match "250000" and "api".
  for (const raw of String(text ?? "").toLowerCase().matchAll(/\p{Script=Hangul}+|(?:(?!\p{Script=Hangul})[\p{L}\p{N}])+(?:[,.:](?:(?!\p{Script=Hangul})[\p{L}\p{N}])+)*/gu)) {
    const word = raw[0].replace(/(\d),(?=\d{3})/g, "$1");
    if (word.length < 2) continue;
    out.add(word);
    if (/^\p{Script=Hangul}/u.test(word)) { out.add(word.slice(0, 2)); if (word.length > 3) out.add(word.slice(0, 3)); }
  }
  return out;
}

/** A long piece cut to the parts around the words it shares with the draft, plus its head. */
function excerpt(text, shared, max = EVIDENCE_ITEM_CHARS) {
  const flat = String(text).replace(/\n+/g, " / ");
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const spans = [[0, 300]];
  for (const term of [...shared].sort((a, b) => b.length - a.length)) {
    const at = lower.indexOf(term);
    if (at >= 0) spans.push([Math.max(0, at - 300), at + term.length + 300]);
    if (spans.length > 6) break;
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    if (merged.length && span[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([a, b]) => flat.slice(a, b)).join(" … ").slice(0, max);
}

/** For each sentence of the draft, this many best-matching pieces go in before any other. */
const PER_SENTENCE = 3;

/**
 * The evidence one check reads: the newest pieces; then for each sentence of `query` its best-matching
 * pieces (rarer shared words count more, BM25-style, so a long status file does not win on length),
 * the best of every sentence before the second-best of any; then the best of the rest, inside `budget`.
 * Back in time order, numbered E1.. Pure.
 */
export function pickEvidence(items, query, { budget = EVIDENCE_CHARS } = {}) {
  const sentences = String(query ?? "").split(/\n+|(?<=[.!?])\s+/u).map((part) => terms(part)).filter((set) => set.size >= 2);
  const wanted = new Set(sentences.flatMap((set) => [...set]));
  const sets = items.map((item) => terms(item.text));
  const df = new Map();
  for (const set of sets) for (const term of set) if (wanted.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const average = items.reduce((sum, item) => sum + item.text.length, 0) / Math.max(1, items.length) || 1;
  const norms = items.map((item) => 2.2 / (1 + 1.2 * (0.25 + 0.75 * item.text.length / average)));
  const scoreOf = (i, want) => [...sets[i]].reduce((sum, term) => sum + (want.has(term) ? Math.log(1 + items.length / df.get(term)) : 0), 0) * norms[i];
  const entries = items.map((item, i) => ({ item, i, shared: new Set() }));
  const rankings = sentences.map((want) => entries.map((entry) => ({ entry, score: scoreOf(entry.i, want), want }))
    .filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, PER_SENTENCE));
  for (const ranking of rankings) for (const row of ranking) for (const term of row.want) if (sets[row.entry.i].has(term)) row.entry.shared.add(term);
  const overall = entries.map((entry) => ({ entry, score: scoreOf(entry.i, wanted) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  for (const row of overall) if (!row.entry.shared.size) for (const term of wanted) if (sets[row.entry.i].has(term)) row.entry.shared.add(term);
  const chosen = new Set();
  let used = 0;
  const take = (entry) => {
    if (chosen.has(entry)) return;
    const text = excerpt(entry.item.text, entry.shared);
    if (used + text.length > budget && chosen.size) return;
    entry.text = text;
    used += text.length;
    chosen.add(entry);
  };
  entries.slice(-RECENT_EVIDENCE).reverse().forEach(take);
  for (let rank = 0; rank < PER_SENTENCE; rank++) for (const ranking of rankings) if (ranking[rank]) take(ranking[rank].entry);
  overall.forEach((row) => take(row.entry));
  return entries.filter((entry) => chosen.has(entry)).map((entry, i) => ({ id: `E${i + 1}`, index: entry.item.index, kind: entry.item.kind,
    label: entry.item.label, at: entry.item.at, text: entry.text }));
}

/** One line for the prompt. A long one keeps its head and its tail: the user's point is often at the end. */
const clip = (text, max = LINE_CHARS) => {
  const flat = String(text ?? "").replace(/\n+/g, " / ").trim();
  if (flat.length <= max) return flat;
  const head = Math.floor(max / 4);
  return `${flat.slice(0, head)} … ${flat.slice(flat.length - (max - head))}`;
};
const speaker = (item) => item.who === "user" ? "사용자" : "나";

/** The draft's lines that carry words, numbered from 1. */
export function draftLines(draft) {
  return String(draft ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

export const ANSWER_SYSTEM = [
  "너는 비서(나)가 사용자에게 보낼 답장을 보내기 직전에 딱 하나만 봐: 이 답이 사용자가 물은 것·짚은 것에 답하나. 말투, 길이, 내용이 사실인지는 보지 마(사실은 다른 검사가 봐).",
  "사용자가 내 마지막 답 뒤에 보낸 줄이 번호 붙어서 와. 사용자는 한 생각을 여러 줄·여러 메시지로 나눠 쳐서, 앞줄은 배경이고 마지막 줄이 진짜 요점인 경우가 많아. 다른 사람 말을 옮겨 붙이고 끝에 자기 질문을 다는 경우도 많아(\"…라고 요청했는데 / 이거도 동문서답 아니야?\"): 그때 요점은 끝의 질문이야. 초안은 줄마다 번호가 붙어서 와.",
  "",
  "해야 할 일:",
  "1. asks: 사용자가 물었거나, 짚었거나, 부탁했거나, 고르라고 한 것만 뽑아. 요점이 하나도 없으면 빈 배열이야.",
  "   요점인 것: 질문(~야?, 왜 ~?, 됐어?, 있어?), 부탁·지시(~해줘, ~하자, ~멈춰, \"~도 같이 보고\" = 같이 봐줘), 잘못을 짚거나 화내는 말(\"왜 그렇게 말해\", \"동문서답 하지 말랬잖아\"), 내 말을 바로잡는 말(\"아니 안 멈췄는데\").",
  "   요점이 아닌 것: 수다, 애정 표현, 인사, 받는 말(응, ㅇㅋ, 고마워, 잘자), 사실만 전하는 말, 혼잣말 같은 추측(\"알아서 하지 않을까\"), 이미 한 일 통보(\"내가 지웠어\"), 사진만 보낸 것. 다른 사람 말을 옮겨 온 줄이 사용자 질문의 배경이면 따로 뽑지 마.",
  "   q: 요점을 사용자 말에 가깝게 40자 안으로. 질문이 바로 앞줄에서 나온 일을 가리키면(\"그거 뭐야?\", \"이상하게 한 거야?\") q에 그 일을 같이 써: 예) 앞줄에서 계좌를 따로 묻는 문제를 옮기고 \"개발실이랑 CSR 응대 이상하게 한 거야?\"면 q는 \"계좌 따로·앞장뒷장 문제가 내 개발실·CSR 응대 탓이냐\".",
  "   kind: 질문이면 \"question\", 부탁·지시면 \"request\", 화내거나 짚거나 바로잡는 말이면 \"complaint\". options: 사용자가 둘 이상 중에 고르라고 했거나 \"A하거나 B하거나\"처럼 선택지를 줬으면 그 선택지들, 아니면 빈 배열.",
  "2. 요점마다 line: 초안에서 그 요점에 대한 답이 시작되는 줄 번호(1부터). 어느 줄도 답하지 않으면 0.",
  "   답인 것: 물은 것을 바로 말하는 줄. 설명을 부탁했을 때 설명의 첫 줄. 답을 바로 여는 짧은 머리말(\"쉽게 말하면 이래.\", \"이렇게 어때?\", \"찾았어!\") 뒤에 그 답이 곧바로 오면 그 머리말 줄부터 답이야. 부탁·지시에 그 일을 했다/하는 중/하겠다는 줄. 화내는 말에 인정·사과하거나 그 앞 질문에 제대로 다시 답하는 줄. 바로잡는 말을 받아들이고 그에 맞춰 한 일을 말하는 줄. 질문이 두 가지로 읽히면 말이 되는 쪽으로 읽고 바로 답한 줄(\"한두시간 걸린다 그거는 뭐야?\"에 \"출금 거절 알림이야\"). 응/웅 뒤에 결론이나 할 일이 붙은 줄(\"바로 완성 가능해?\"에 \"웅 바로 해!\", \"일단 둘까?\"에 \"웅 그럼 맡겨 둘게\"). 부탁·지시가 여럿이면 그중 하나를 했다는 줄도 답이야. 됐냐고 물었을 때 어디까지 됐는지 말하는 줄(\"숫자만 고쳤어, 이름은 아직이야\")도 답이야. 사용자가 속상함·걱정·하소연을 털어놓을 때(\"대체 뭘 보고 그렇게 말하는 거지?\", \"잘 돌아갈지 모르겠어\") 공감하고 받아주는 줄도 답이야.",
  "   답이 아닌 것(이런 줄이 앞을 차지하면 line은 그 뒤의 진짜 답 줄이거나 0):",
  "   - 질문이 앞에서 나온 특정한 일을 가리키는데 그 일을 말하지 않는 줄. 응/맞아 한 마디나 \"이렇게 했어:\" 같은 머리말 뒤에 그 일이 아닌 다른 일들을 늘어놓는 것도 여기야. 사용자가 남의 요청이나 상황을 옮겨 온 바로 뒤에 \"이상하게 한 거야?\"처럼 짧게 물으면 그 질문은 \"방금 옮긴 그 상황이 네 응대 때문이냐\"고, 답은 그 상황을 만든 응대를 짚는 줄이야.",
  "   - 선택지가 있는데 그중 어느 쪽인지(또는 둘 다 아니고 왜 아닌지)를 말하지 않고 제3의 방식이나 다른 사실을 말하는 줄.",
  "   - \"왜\"를 물었는데 이유나 그게 무엇인지 설명 없이 지금 상태나 해결법(\"새로고침하면 없어져\")만 말하는 줄.",
  "   - 사용자가 다른 기준을 말했는데(\"한 달 기준으로 물은 건데\") 그 기준으로 답하지 않는 줄.",
  "   - 물은 것과 관련은 있지만 다른 걸 말하는 줄: 안 물은 사실 보고, 다른 실수 목록, 설계 이유, 그날 한 일 나열.",
  "   how: 그 줄이 실제 답·인정·사과·조치면 \"answer\", 물은 정보를 아직 안 주고 확인하겠다는 약속뿐(\"볼게\", \"확인해볼게\")이면 \"promise\", line이 0이면 \"none\". 부탁·지시에 \"할게\"로 받는 건 answer야.",
  "3. first_says: 초안 1번 줄이 실제로 말하는 것을 한 구절로. lead_in: 1번 줄이 자기 내용 없이 바로 아래 답을 여는 짧은 머리말이나 응/맞아 한 마디(\"쉽게 말하면 이래.\", \"찾았어!\", \"응, 이상하게 했어.\")면 true, 1번 줄이 무언가 사실이나 다른 말을 하면(\"네 19일부터 바뀌었습니다\") false.",
  "4. hint: 고쳐 쓰는 법 한 문장(50자 안으로). 첫 줄에 뭘 말해야 하는지.",
  "",
  "\"이미 보낸 내 답\"이 있으면 그건 사용자가 이미 받은 거야. 거기서 확인하겠다고만 했으면 초안이 그 진짜 답이어야 해.",
  "",
  "JSON 하나로만 답해, 다른 글 없이: {\"asks\":[{\"q\":\"...\",\"kind\":\"question\",\"options\":[],\"line\":0,\"how\":\"none\"}],\"first_says\":\"...\",\"lead_in\":false,\"hint\":\"...\"}",
].join("\n");

export const GROUND_SYSTEM = [
  "너는 비서(나)가 사용자에게 보낼 답장을 보내기 직전에 딱 하나만 봐: 답장의 사실 문장이 내가 이번 창에서 실제로 본 증거에 있나. 증거는 번호(E1..)가 붙어서 오고, 도구 결과, 리드·다른 대화의 메시지, 인박스 알림, 사용자 말이야. 말투, 길이, 질문에 답했는지는 보지 마(다른 검사가 봐).",
  "",
  "해야 할 일:",
  "1. claims: 초안의 사실 문장마다 하나씩. 따옴표나 >로 인용한, 다른 사람에게 보낼 글 안의 문장도 넣어. s는 그 문장 앞부분 30자, t는 \"fact\"(단정하는 사실) 또는 \"hedge\"(짐작이거나, 모르거나, 아직 안 했다고 밝힌 문장: \"내 짐작이야\", \"~같아\", \"확인 안 됐어\", \"아직 안 봤어\"), ev는 그 문장을 받치는 증거 번호들(예: [\"E3\"]).",
  "   cls는 문장의 종류: \"number\"(금액·시각·건수·잔액 같은 숫자), \"done\"(됐다·고쳤다·확인했다·맞다·똑같다·배포됐다·올라갔다처럼 끝났거나 확인됐다는 단정), \"behavior\"(형님·업체·실무자·회원·88·우리 시스템이 무엇을 했다·말했다, 어떻게 동작한다: \"유저가 신청하면 저희 쪽에 올라온다\"), \"cause\"(일이 왜 일어났는지 단정: \"~때문이야\", \"~해서 그런 거야\"), \"mine\"(내가 한 일: 보냈어, 맡겼어, 리드 띄웠어), \"other\"(그 밖). 한 문장이 여럿이면 앞의 것(number, done, behavior, cause 순)으로 골라.",
  "   사실 문장(넣을 것): 우리 일에 대한 단정이야. 우리 시스템·서버·화면, 업체, 형님·실무자·사용자, 통장과 돈, 리드, 오늘 일어난 일에 대해 숫자·금액·시각, 무엇이 어떤 상태다(됐다, 고쳤다, 올라와 있다, 막혀 있다), 누가 무엇을 했다·말했다, 일이 일어난 원인, 어떻게 동작한다. 내가 한 일(\"리드한테 맡겼어\", \"형님방에 보냈어\")도 사실 문장이야.",
  "   넣지 마: 감정·공감·사과·인사, 계획·약속(할게, 보낼게, 리드한테 맡길게), 질문, 제안·의견·조언(~하면 좋겠어, \"그렇게 전달하면 돼\"), 사용자가 방금 한 말을 되받는 말, 사용자 자신의 일·기분을 받아 주는 말(\"밤샜으니까 피곤하지\"), 내 잘못을 인정하거나 내 행동을 돌아보는 말(\"내가 틀리게 말했어\", \"규칙이 없어서가 아니라 내가 안 읽은 거야\"), 내 판단·평가·추천과 그 이유(\"바이어가 아니니까 빼면 돼\", \"그렇게 급한 건 별로 없으니까\", \"명세 먼저 정하는 건 흔한 순서야\"), 내가 지금 기다리거나 하고 있다는 말(\"답 기다리는 중이야\"), 만들거나 고칠 것이 앞으로 어떻게 동작할지의 설명(\"사진이 있으면 알아서 받아 두게 할게\"), 우리 일과 상관없는 일반 상식·법·기술 일반론(\"주민번호를 저장하면 개인정보법상 위험해\", \"처음 한 번은 main을 받아와야 해\").",
  "   받침: 증거에 그대로 있거나 증거 몇 개에서 바로 따라 나오면 받침이야. 증거에 없거나, 증거와 반대이거나, 증거가 \"확인 안 됨\"·\"기록에 안 남음\"이라고 한 것을 단정하면 ev는 []. 그럴듯한 일반 설명(\"보통 유저가 신청하면 올라온다\")도 증거에 없으면 [].",
  "   \"다 고쳤다\", \"똑같이 보인다\", \"확인했다\"처럼 끝났다·맞다는 문장은 증거가 바로 그만큼을 확인했을 때만 받침이야. 숫자를 맞췄다는 보고는 \"이름도 콘솔이랑 같다\"를 받치지 못해.",
  "   증거의 [사진]은 내용을 볼 수 없어: 바로 그 사진이 보여 주는 것에 대한 문장이면 그 사진이 있는 증거 번호를 ev로 써.",
  "   [내가 한 일] 증거는 내가 그 일을 했다·그 말을 보냈다는 문장만 받쳐. 거기 쓴 내용이 사실이라는 받침은 아니야: 내가 리드한테 \"API로 만들어졌다\"고 썼어도 \"API로 만들어졌다\"는 사실 문장은 받침이 없어.",
  "   내 예전 답장은 증거가 아니야. 증거 칸에 없는 말은 내가 전에 했어도 받침이 없어.",
  "2. challenge: 최근 대화(C번호)에서 사용자가 내가 한 말을 의심하거나 되묻는 줄(\"확실해?\", \"맞아?\", \"진짜?\", \"그니까 ~가 아니라고?\")의 가장 최근 C번호, 없으면 0. 사용자가 새 사실이나 바로잡는 정보를 주면(\"형님이 통장 없어진 적 없대\", \"아까 말한 800 통장값 아님?\", \"그런 얘기 들은 적 없는데\") 그건 의심이 아니라 증거라서 그 줄은 고르지 마. changed: 초안이 그 의심받은 내 말을 뒤집거나 바꾸면 true, 그대로 두거나 근거를 대며 유지하면 false.",
  "",
  "JSON 하나로만 답해, 다른 글 없이: {\"claims\":[{\"s\":\"...\",\"t\":\"fact\",\"cls\":\"behavior\",\"ev\":[\"E1\"]}],\"challenge\":{\"c\":0,\"changed\":false}}",
].join("\n");

const draftBlock = (draft) => `## 보낼 초안 (줄 번호: 내용)\n${draftLines(draft).map((line, i) => `${i + 1}: ${line}`).join("\n")}`;

/** The answer check's system prompt and user message: the waiting lines, what came before, the draft. Pure. */
export function answerPrompt({ lines, sent = [], context = [], draft }) {
  const parts = [];
  if (context.length) parts.push(`## 그 앞 대화 (참고만)\n${context.map((item) => `${speaker(item)}: ${clip(item.text)}`).join("\n")}`);
  parts.push(`## 사용자가 내 마지막 답 뒤에 보낸 줄\n${lines.map((item, i) => `${i + 1}. ${clip(item.text, USER_LINE_CHARS)}`).join("\n")}`);
  if (sent.length) parts.push(`## 이미 보낸 내 답 (그 뒤에)\n${sent.map((item) => `- ${clip(item.text)}`).join("\n")}`);
  parts.push(draftBlock(draft));
  return { system: ANSWER_SYSTEM, user: parts.join("\n\n") };
}

/** The grounding check's system prompt and user message: the evidence, the recent turns, the draft. Pure. */
export function groundPrompt({ recent = [], evidence = [], draft }) {
  const stamp = (at) => at === undefined ? "" : ` · ${new Date(at).toISOString().slice(5, 16).replace("T", " ")}Z`;
  const parts = [`## 증거: 이번 창에서 내가 본 것\n${evidence.length
    ? evidence.map((item) => `${item.id} [${item.label}${stamp(item.at)}] ${item.text}`).join("\n") : "(없음)"}`];
  if (recent.length) parts.push(`## 최근 대화 (C번호)\n${recent.map((item, i) => `C${i + 1} ${speaker(item)}: ${clip(item.text)}`).join("\n")}`);
  parts.push(draftBlock(draft));
  return { system: GROUND_SYSTEM, user: parts.join("\n\n") };
}

const jsonOf = (raw, label) => {
  const json = String(raw ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`the ${label} check did not answer in JSON: ${String(raw ?? "").slice(0, 120)}`);
  return JSON.parse(json);
};

/**
 * The answer check's mapping -> its verdict. Code decides, not the model: answered when nothing was
 * asked, or every point has an answering line and the first line answers one of them. `cleared` is
 * false when a point got only a promise: the user's question keeps waiting for the next reply.
 */
export function parseAnswer(raw, { lines = [] } = {}) {
  const lineCount = lines.length || Infinity;
  const value = jsonOf(raw, "answer");
  if (!Array.isArray(value.asks)) throw new Error(`the answer check's JSON has no asks: ${JSON.stringify(value).slice(0, 120)}`);
  // A record the model got wrong is no verdict: an ask without its words, or a line and a "how" that
  // contradict each other, sends the check to the next model instead of being repaired into a pass.
  for (const ask of value.asks) {
    const said = Number(ask?.line);
    if (typeof ask?.q !== "string" || !ask.q.trim() || !Number.isInteger(said) || said < 0
      || !["answer", "promise", "none"].includes(ask?.how) || (said === 0) !== (ask.how === "none")) {
      throw new Error(`the answer check returned a malformed ask: ${JSON.stringify(ask).slice(0, 120)}`);
    }
  }
  const asks = value.asks.map((ask) => {
    const line = Number(ask.line) <= lineCount ? Number(ask.line) : 0;
    const how = line === 0 ? "none" : ask.how;
    const kind = ["question", "request", "complaint"].includes(ask?.kind) ? ask.kind : "question";
    return { q: ask.q.trim(), kind, options: (Array.isArray(ask?.options) ? ask.options : []).map(String).filter(Boolean), line, how };
  });
  // A work order next to a question ("확인하고 마저 하자" with "왜 안 되냐") is done, not answered in
  // words: it holds the reply back only when there is nothing else to answer, or when it gave options.
  const answerable = asks.some((ask) => ask.kind !== "request");
  const missed = asks.filter((ask) => ask.line === 0 && (ask.kind !== "request" || !answerable || ask.options.length > 0));
  // The answer starts on line 1, or on line 2 behind a short lead-in ("쉽게 말하면 이래.", "찾았어!"):
  // short by count and, in the model's reading, saying nothing of its own ("네 19일부터 바뀌었습니다" does).
  const leadIn = value.lead_in === true && lines.length >= 2 && String(lines[0]).length <= LEAD_IN_CHARS;
  const firstAnswers = asks.length === 0 || asks.some((ask) => ask.line === 1 || (leadIn && ask.line === 2));
  const answered = missed.length === 0 && firstAnswers;
  return { answered, cleared: answered && asks.every((ask) => ask.how === "answer"), asks, missed, firstAnswers,
    firstSays: String(value.first_says ?? "").trim(), hint: String(value.hint ?? "").trim() };
}

/**
 * The grounding check's mapping -> its verdict. `unsupported`: factual sentences of a kind that needs
 * evidence (GROUNDED_CLASSES; not a "hedge" that says it is a guess or unknown) with no evidence
 * among `evidenceIds`. `flip`: the user
 * doubted a claim (a line of `recent`) and the draft changes it with no tool result since
 * (`toolResultsSince(index)` is 0).
 */
export function parseGround(raw, { evidenceIds, recent = [], toolResultsSince = () => 0 } = {}) {
  const value = jsonOf(raw, "grounding");
  if (!Array.isArray(value.claims)) throw new Error(`the grounding check's JSON has no claims: ${JSON.stringify(value).slice(0, 120)}`);
  for (const claim of value.claims) {
    if (typeof claim?.s !== "string" || !claim.s.trim() || !Array.isArray(claim.ev)) {
      throw new Error(`the grounding check returned a malformed claim: ${JSON.stringify(claim).slice(0, 120)}`);
    }
  }
  // An evidence number the check was not given supports nothing. A kind the model did not name is
  // treated as one that needs evidence.
  const claims = value.claims.map((claim) => ({ s: claim.s.trim(), t: claim.t === "hedge" ? "hedge" : "fact",
    cls: GROUNDED_CLASSES.has(claim.cls) || ["mine", "other"].includes(claim.cls) ? claim.cls : "behavior",
    ev: claim.ev.map(String).filter((id) => !evidenceIds || evidenceIds.has(id)) }));
  const unsupported = claims.filter((claim) => claim.t === "fact" && GROUNDED_CLASSES.has(claim.cls) && claim.ev.length === 0).map((claim) => claim.s);
  const doubt = Number(value.challenge?.c);
  const doubted = Number.isInteger(doubt) && doubt > 0 ? recent[doubt - 1] : undefined;
  const flip = value.challenge?.changed === true && doubted?.who === "user" && toolResultsSince(doubted.index) === 0 ? doubted.text : undefined;
  return { claims, unsupported, ...(flip ? { flip } : {}) };
}

/**
 * The kinds of factual sentence that need evidence: where made-up words hurt on 11-22 (a number, a
 * "다 고쳤다", what someone or a system did or does, a cause). Over every factual sentence, three in
 * five of the companion's past replies were held back and a hand count of 25 found most of them
 * wrong to hold (its own acts, plans, opinions, general knowledge); its own acts ("mine") and the rest
 * ("other") go out unchecked.
 */
export const GROUNDED_CLASSES = Object.freeze(new Set(["number", "done", "behavior", "cause"]));

/** The two verdicts as one: ok only when the reply answers (or nothing waits) and is grounded. */
export function combineVerdicts(answer, ground) {
  const answered = answer ? answer.answered : true;
  return { ok: answered && ground.unsupported.length === 0 && !ground.flip, answered, cleared: answer ? answer.cleared : true,
    asks: answer?.asks ?? [], missed: answer?.missed ?? [], firstAnswers: answer?.firstAnswers ?? true,
    firstSays: answer?.firstSays ?? "", hint: answer?.hint ?? "", ...ground };
}

/** What the companion reads when its reply was held back. */
export function refusalText(verdict) {
  const out = ["Not delivered (reply check). Nothing reached the user. Fix what is named below and call reply again."];
  if (verdict.repeatPromise) {
    out.push(`- You already told the user you would look into "${verdict.asks.find((ask) => ask.how === "promise")?.q ?? "it"}". This reply promises again instead of answering.`);
    out.push("  Give the answer now, or say plainly in the first line what you found so far and what is still unknown.");
  }
  if (verdict.answered === false) {
    out.push("- It does not answer what the user said:");
    if (!verdict.firstAnswers) {
      const main = verdict.asks.at(-1);
      out.push(`  The user's point: "${main?.q ?? "?"}"${main?.options?.length ? ` (their options: ${main.options.join(" / ")})` : ""}`);
      out.push(`  Your first line says instead: "${verdict.firstSays || "?"}"`);
    }
    for (const ask of verdict.missed) {
      if (!verdict.firstAnswers && ask === verdict.asks.at(-1)) continue;
      out.push(`  No line answers: "${ask.q}"${ask.options.length ? ` (their options: ${ask.options.join(" / ")}; say which one)` : ""}`);
    }
    if (verdict.hint) out.push(`  Hint: ${verdict.hint}`);
    out.push("  Put the answer itself in the first line: the reason when they asked why, the option you take when they gave options, the thing they pointed at when they said 그거. If you do not know yet, say that in the first line.");
  }
  if (verdict.unsupported?.length) {
    out.push("- Nothing you saw in this window (tool results, leads' messages, inbox, the user's words) supports:");
    for (const sentence of verdict.unsupported) out.push(`  "${sentence}"`);
    out.push("  Check it first (a tool, the lead), or say it is unconfirmed, or leave it out. A sentence you said earlier is not evidence.");
  }
  if (verdict.flip) {
    out.push(`- The user doubted your claim ("${clip(verdict.flip, 120)}") and this reply changes it, with no tool result since that question.`);
    out.push("  Check first and answer with what you found, or keep the claim and say what it rests on. Do not change a claim because it was questioned.");
  }
  out.push("This check has no override.");
  return out.join("\n");
}

/** What the companion reads when no model could run the check: refused, not passed. */
export function unavailableText(errors) {
  return `Not delivered: the reply check could not run (${errors.join("; ")}), and a reply goes out only after it. ` +
    "Nothing reached the user. Try reply again in a moment.";
}

const shuffled = (items, random) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};
const responseText = (response) => textOf(response?.content ?? response);

/**
 * Runs one check through the model ladder: tier by tier, the accounts of a tier in random order, the
 * first parsable answer wins. Returns { verdict, model } or { errors }.
 */
async function ask(registry, models, { system, user, reasoning, parse, now, random, timeoutMs }) {
  const errors = [];
  for (const candidate of models.flatMap((tier) => shuffled(tier, random))) {
    const name = `${candidate.provider}/${candidate.id}`;
    const model = registry?.find?.(candidate.provider, candidate.id);
    if (!model) { errors.push(`${name}: not in this engine`); continue; }
    if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) { errors.push(`${name}: not signed in`); continue; }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await Promise.race([
        registry.complete(model, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: now }] },
          { cacheRetention: "none", sessionId: `rubato-answer-check-${now}-${candidate.id}`, reasoning, maxTokens: 8192, signal }),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(`no answer in ${timeoutMs}ms`)), { once: true })),
      ]);
      if (response?.stopReason === "error" || response?.errorMessage) throw new Error(response.errorMessage || "error");
      return { verdict: parse(responseText(response)), model: name };
    } catch (error) {
      errors.push(`${name}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  return { errors };
}

/**
 * Checks one draft: the answer check (only when user lines wait) and the grounding check (always),
 * side by side, so the wait is the slower of the two. The answer check thinks when it needs to
 * (reasoning "high": on the 11-22 cases, without thinking it passed the "응, 이상하게 한 거 맞아" reply
 * and refused two good ones); the grounding check reads a long evidence list and answers without
 * thinking ("low"), about 2.5 seconds. `registry` is the session's model registry (find,
 * hasConfiguredAuth, complete). Returns { checked: true, ok, cleared, verdict, models, pending,
 * evidence } or { checked: true, ok: false, unavailable: true, errors }. Never throws for a model failure.
 */
export async function checkReply({ entries, draft, registry, now = Date.now(), random = Math.random,
  models = ANSWER_CHECK_MODELS, timeoutMs = ANSWER_CHECK_TIMEOUT_MS }) {
  const pending = pendingAsk(entries, { now });
  const seen = evidenceOf(entries);
  const evidence = pickEvidence(seen, [draft, ...(pending?.lines ?? []).map((line) => line.text)].join("\n"));
  const recent = conversation(entries).filter((item) => item.who !== "event").slice(-RECENT_TURNS);
  const toolResultsSince = (index) => seen.filter((item) => item.kind === "tool" && item.index > index).length;
  const lines = draftLines(draft);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const common = { now, random, timeoutMs };
  const [answer, ground] = await Promise.all([
    pending ? ask(registry, models, { ...answerPrompt({ ...pending, draft }), reasoning: "high", parse: (raw) => parseAnswer(raw, { lines }), ...common }) : undefined,
    ask(registry, models, { ...groundPrompt({ recent, evidence, draft }), reasoning: "low", parse: (raw) => parseGround(raw, { evidenceIds, recent, toolResultsSince }), ...common }),
  ]);
  const errors = [...(answer?.errors ?? []).map((error) => `answer check: ${error}`), ...(ground.errors ?? []).map((error) => `grounding check: ${error}`)];
  if (errors.length && (answer?.errors || ground.errors)) return { checked: true, ok: false, unavailable: true, errors, pending, evidence };
  const verdict = combineVerdicts(answer?.verdict, ground.verdict);
  // A second "볼게" for a question already promised once is stalling, not an answer.
  if (pending && verdict.answered && !verdict.cleared && pending.sent.length) verdict.repeatPromise = true;
  return { checked: true, ok: verdict.ok && !verdict.repeatPromise, cleared: verdict.cleared, verdict,
    model: [answer?.model, ground.model].filter(Boolean).join(" + "), pending, evidence };
}
