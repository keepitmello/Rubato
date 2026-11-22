// The answer check on the companion's `reply`: a reply to the user's own messages reaches them only
// when it answers what they said. User, 2026-11-22, after ~20 corrections in one morning:
// "구조적으로 동문서답 자체가 불가능하게 하라고", "제발 동문서답 하지 말라고 내가 20번은 말하지않았냐".
//
// Before `reply` delivers, one model call (Claude Sonnet; Haiku when Sonnet cannot answer) reads every line the user sent since the
// companion's last reply that answered them, a few turns before that, and the draft. The model only
// maps: what the user asked or pointed out, and which line of the draft answers each. Code decides:
// the reply goes out only when every point has an answering line and the first line is one of them.
// A refusal is thrown back to the companion with what it missed, and nothing is delivered.
//
// There is no switch to skip it. When no model answers (every model on both Anthropic accounts down or out of quota),
// the reply is refused with that said: a silent pass would make the check optional exactly when it
// matters least to notice. Proactive messages (heartbeat, a lead's ending, a greeting) with no user
// line waiting are not checked.
//
// Pure parts first (conversation, pendingAsk, checkPrompt, parseVerdict, refusalText), the model call
// at the bottom (checkReply). The same rules ran on the user's Telegram sends since 11-22
// (tg-mtproto answer.mjs); this adds the "A or B, answered with C" case and the promise rule.

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
export const ANSWER_CHECK_TIMEOUT_MS = 15_000;
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

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => part?.type === "text" ? part.text ?? ""
    : part?.type === "image" ? "[사진]" : "").join("") : "";
const atOf = (value) => { const at = typeof value === "number" ? value : Date.parse(value ?? ""); return Number.isFinite(at) ? at : undefined; };

/**
 * One session branch (entries, or the in-memory messages) as the chat between the user and the
 * companion: { who: "user" | "me" | "event", text, at, cleared? }. "me" is a reply that went through;
 * `cleared` is false when its check passed only on a promise to look, so the user's question still waits.
 * "event" is anything else that woke the companion (a wake, a lead's notice, another conversation).
 * A line heard on a call ("[voice] ") is answered on the call and is not part of this chat.
 */
export function conversation(entries) {
  const calls = new Map();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = entry?.type === "message" ? entry.message : entry?.type === "custom_message" ? { ...entry, role: "custom" } : entry;
    if (!message || typeof message !== "object") continue;
    const at = atOf(message.timestamp ?? entry?.timestamp);
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text && !text.startsWith("[voice] ") && text !== RESTART_CONTINUE_TEXT) out.push({ who: "user", text, at });
    } else if (message.role === "custom") {
      const details = message.details ?? {};
      if (message.customType === "rubato-session-message" && details.kind === "channel" && details.from?.isUser === true) {
        const text = String(details.text ?? "").trim();
        if (text) out.push({ who: "user", text, at });
      } else if (message.customType === "rubato-session-message") out.push({ who: "event", text: details.kind ?? "", at });
    } else if (message.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && ANSWER_CHECK_TOOL_NAMES.includes(part.name)) calls.set(part.id, part.arguments ?? {});
      }
    } else if (message.role === "toolResult" && ANSWER_CHECK_TOOL_NAMES.includes(message.toolName) && calls.has(message.toolCallId)) {
      const args = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (message.isError === true) continue;
      const text = String(args.text || args.voice_text || "").trim();
      out.push({ who: "me", text, at, cleared: message.details?.answerCheck?.cleared !== false });
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

export const CHECK_SYSTEM = [
  "너는 비서(나)가 사용자에게 보낼 답장을 보내기 직전에 딱 하나만 봐: 이 답이 사용자가 물은 것·짚은 것에 답하나. 말투, 길이, 내용이 사실인지는 보지 마.",
  "사용자가 내 마지막 답 뒤에 보낸 줄이 번호 붙어서 와. 사용자는 한 생각을 여러 줄·여러 메시지로 나눠 쳐서, 앞줄은 배경이고 마지막 줄이 진짜 요점인 경우가 많아. 다른 사람 말을 옮겨 붙이고 끝에 자기 질문을 다는 경우도 많아(\"…라고 요청했는데 / 이거도 동문서답 아니야?\"): 그때 요점은 끝의 질문이야. 초안은 줄마다 번호가 붙어서 와.",
  "",
  "해야 할 일:",
  "1. asks: 사용자가 물었거나, 짚었거나, 부탁했거나, 고르라고 한 것만 뽑아. 요점이 하나도 없으면 빈 배열이야.",
  "   요점인 것: 질문(~야?, 왜 ~?, 됐어?, 있어?), 부탁·지시(~해줘, ~하자, ~멈춰, \"~도 같이 보고\" = 같이 봐줘), 잘못을 짚거나 화내는 말(\"왜 그렇게 말해\", \"동문서답 하지 말랬잖아\"), 내 말을 바로잡는 말(\"아니 안 멈췄는데\").",
  "   요점이 아닌 것: 수다, 애정 표현, 인사, 받는 말(응, ㅇㅋ, 고마워, 잘자), 사실만 전하는 말, 혼잣말 같은 추측(\"알아서 하지 않을까\"), 이미 한 일 통보(\"내가 지웠어\"), 사진만 보낸 것. 다른 사람 말을 옮겨 온 줄이 사용자 질문의 배경이면 따로 뽑지 마.",
  "   q: 요점을 사용자 말에 가깝게 40자 안으로. 질문이 바로 앞줄에서 나온 일을 가리키면(\"그거 뭐야?\", \"이상하게 한 거야?\") q에 그 일을 같이 써: 예) 앞줄에서 계좌를 따로 묻는 문제를 옮기고 \"개발실이랑 CSR 응대 이상하게 한 거야?\"면 q는 \"계좌 따로·앞장뒷장 문제가 내 개발실·CSR 응대 탓이냐\".",
  "   kind: 질문이면 \"question\", 부탁·지시면 \"request\", 화내거나 짚거나 바로잡는 말이면 \"complaint\". options: 사용자가 둘 이상 중에 고르라고 했거나 \"A하거나 B하거나\"처럼 선택지를 줬으면 그 선택지들, 아니면 빈 배열.",
  "2. 요점마다 line: 초안에서 그 요점에 대한 답이 시작되는 줄 번호(1부터). 어느 줄도 답하지 않으면 0.",
  "   답인 것: 물은 것을 바로 말하는 줄. 설명을 부탁했을 때 설명의 첫 줄. 답을 바로 여는 짧은 머리말(\"쉽게 말하면 이래.\", \"이렇게 어때?\", \"찾았어!\") 뒤에 그 답이 곧바로 오면 그 머리말 줄부터 답이야. 부탁·지시에 그 일을 했다/하는 중/하겠다는 줄. 화내는 말에 인정·사과하거나 그 앞 질문에 제대로 다시 답하는 줄. 바로잡는 말을 받아들이고 그에 맞춰 한 일을 말하는 줄. 질문이 두 가지로 읽히면 말이 되는 쪽으로 읽고 바로 답한 줄(\"한두시간 걸린다 그거는 뭐야?\"에 \"출금 거절 알림이야\"). 응/웅 뒤에 결론이나 할 일이 붙은 줄(\"바로 완성 가능해?\"에 \"웅 바로 해!\", \"일단 둘까?\"에 \"웅 그럼 맡겨 둘게\"). 부탁·지시가 여럿이면 그중 하나를 했다는 줄도 답이야. 사용자가 속상함·걱정·하소연을 털어놓을 때(\"대체 뭘 보고 그렇게 말하는 거지?\", \"잘 돌아갈지 모르겠어\") 공감하고 받아주는 줄도 답이야.",
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

/** The system prompt and the user message for one check. Pure. */
export function checkPrompt({ lines, sent = [], context = [], draft }) {
  const parts = [];
  if (context.length) parts.push(`## 그 앞 대화 (참고만)\n${context.map((item) => `${speaker(item)}: ${clip(item.text)}`).join("\n")}`);
  parts.push(`## 사용자가 내 마지막 답 뒤에 보낸 줄\n${lines.map((item, i) => `${i + 1}. ${clip(item.text, USER_LINE_CHARS)}`).join("\n")}`);
  if (sent.length) parts.push(`## 이미 보낸 내 답 (그 뒤에)\n${sent.map((item) => `- ${clip(item.text)}`).join("\n")}`);
  parts.push(`## 보낼 초안 (줄 번호: 내용)\n${draftLines(draft).map((line, i) => `${i + 1}: ${line}`).join("\n")}`);
  return { system: CHECK_SYSTEM, user: parts.join("\n\n") };
}

/**
 * The model's mapping -> the verdict. Code decides, not the model: ok when nothing was asked, or
 * every point has an answering line and the first line answers one of them. `cleared` is false when
 * a point got only a promise: the user's question keeps waiting for the next reply.
 */
export function parseVerdict(raw, { lines = [] } = {}) {
  const lineCount = lines.length || Infinity;
  const json = String(raw ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`the answer check did not answer in JSON: ${String(raw ?? "").slice(0, 120)}`);
  const value = JSON.parse(json);
  if (!Array.isArray(value.asks)) throw new Error(`the answer check's JSON has no asks: ${json.slice(0, 120)}`);
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
    return { q: String(ask?.q ?? "").trim(), kind, options: (Array.isArray(ask?.options) ? ask.options : []).map(String).filter(Boolean), line, how };
  });
  // A work order next to a question ("확인하고 마저 하자" with "왜 안 되냐") is done, not answered in
  // words: it holds the reply back only when there is nothing else to answer, or when it gave options.
  const answerable = asks.some((ask) => ask.kind !== "request");
  const missed = asks.filter((ask) => ask.line === 0 && (ask.kind !== "request" || !answerable || ask.options.length > 0));
  // The answer starts on line 1, or on line 2 behind a short lead-in ("쉽게 말하면 이래.", "찾았어!"):
  // short by count and, in the model's reading, saying nothing of its own ("네 19일부터 바뀌었습니다" does).
  const leadIn = value.lead_in === true && lines.length >= 2 && String(lines[0]).length <= LEAD_IN_CHARS;
  const firstAnswers = asks.length === 0 || asks.some((ask) => ask.line === 1 || (leadIn && ask.line === 2));
  const ok = missed.length === 0 && firstAnswers;
  return { ok, cleared: ok && asks.every((ask) => ask.how === "answer"), asks, missed, firstAnswers,
    firstSays: String(value.first_says ?? "").trim(), hint: String(value.hint ?? "").trim() };
}

/** What the companion reads when its reply was held back. */
export function refusalText(verdict) {
  const out = ["Not delivered: this reply does not answer what the user said (answer check). Nothing reached the user. Rewrite it and call reply again."];
  if (verdict.repeatPromise) {
    out.push(`- You already told the user you would look into "${verdict.asks.find((ask) => ask.how === "promise")?.q ?? "it"}". This reply promises again instead of answering.`);
    out.push("Give the answer now, or say plainly in the first line what you found so far and what is still unknown.");
    return out.join("\n");
  }
  if (!verdict.firstAnswers) {
    const main = verdict.asks.at(-1);
    out.push(`- The user's point: "${main?.q ?? "?"}"${main?.options?.length ? ` (their options: ${main.options.join(" / ")})` : ""}`);
    out.push(`- Your first line says instead: "${verdict.firstSays || "?"}"`);
  }
  for (const ask of verdict.missed) {
    if (!verdict.firstAnswers && ask === verdict.asks.at(-1)) continue;
    out.push(`- No line answers: "${ask.q}"${ask.options.length ? ` (their options: ${ask.options.join(" / ")}; say which one)` : ""}`);
  }
  if (verdict.hint) out.push(`- Hint: ${verdict.hint}`);
  out.push("Put the answer itself in the first line: the reason when they asked why, the option you take when they gave options, the thing they pointed at when they said 그거. If you do not know yet, say that in the first line. This check has no override.");
  return out.join("\n");
}

/** What the companion reads when no model could run the check: refused, not passed. */
export function unavailableText(errors) {
  return `Not delivered: the answer check could not run (${errors.join("; ")}), and a reply to the user's message goes out only after it. ` +
    "Nothing reached the user. Try reply again in a moment.";
}

const shuffled = (items, random) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};
const responseText = (response) => textOf(response?.content ?? response);

/**
 * Checks one draft. `registry` is the session's model registry (find, hasConfiguredAuth, complete).
 * Returns { checked: false } when nothing waits, else { checked: true, ok, cleared, verdict, model }
 * or { checked: true, ok: false, unavailable: true, errors }. Never throws for a model failure.
 */
export async function checkReply({ entries, draft, registry, now = Date.now(), random = Math.random,
  models = ANSWER_CHECK_MODELS, timeoutMs = ANSWER_CHECK_TIMEOUT_MS }) {
  const pending = pendingAsk(entries, { now });
  if (!pending) return { checked: false };
  const { system, user } = checkPrompt({ ...pending, draft });
  const lines = draftLines(draft);
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
          { cacheRetention: "none", sessionId: `rubato-answer-check-${now}-${candidate.id}`, reasoning: "low", maxTokens: 2048, signal }),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(`no answer in ${timeoutMs}ms`)), { once: true })),
      ]);
      if (response?.stopReason === "error" || response?.errorMessage) throw new Error(response.errorMessage || "error");
      const verdict = parseVerdict(responseText(response), { lines });
      // A second "볼게" for a question already promised once is stalling, not an answer.
      if (verdict.ok && !verdict.cleared && pending.sent.length) verdict.repeatPromise = true;
      return { checked: true, ok: verdict.ok && !verdict.repeatPromise, cleared: verdict.cleared, verdict, model: name, pending };
    } catch (error) {
      errors.push(`${name}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  return { checked: true, ok: false, unavailable: true, errors, pending };
}
