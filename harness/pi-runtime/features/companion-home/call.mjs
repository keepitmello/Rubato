// Reusable companion call transport, adapted from the existing Pi call bridge.
// Audio capture, STT, synthesis and playback remain the caller's capability. This bridge runs
// on the companion's own Pi conversation and emits ONLY explicit call tools, never monologue.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { companionHomeFor, landsInside, localDate, localTime, renewCapability, clearCapability, noteCompanionActivity } from "./home.mjs";
import { buildEnvelope, SESSION_MESSAGE_TYPE } from "../session-link/message.mjs";

export const CALL_SAY_TOOL = "call_say";
export const CALL_WAIT_TOOL = "call_wait";
export const CALL_PASS_TOOL = "call_pass";
export const CALL_TOOLS = Object.freeze([CALL_SAY_TOOL, CALL_WAIT_TOOL, CALL_PASS_TOOL]);
/** Rings the person; it is not a move inside a call turn, so it is not one of CALL_TOOLS. */
export const CALL_USER_TOOL = "call_user";
/** The call service (harness/companion/call-agent/control.mjs) that rings the person's devices. */
const CALL_CONTROL = "http://127.0.0.1:18790";
export const CALL_BODY_BYTES = 256 * 1024;
/** The mark a cut-off call_say ends with in what the companion reads back, as a script marks it. */
export const CUT_MARK = "—";
/** Spoken characters per second when the call has no fully played reply to measure the voice by. */
export const DEFAULT_SPOKEN_PER_SECOND = 6;
/** How many cut-off call_say texts are kept; a dropped one reads in full again. */
const CUTS_KEPT = 1000;
export const CALL_WAIT_SECONDS = Object.freeze({ min: 5, max: 300 });
/**
 * The conversation's effort while a call is open, from `call.effort` in the companion's
 * settings.json. The same list and default as CALL_EFFORTS / DEFAULT_SETTINGS in
 * harness/companion/companion.mjs, its canonical home; repeated because this file also runs where
 * companion.mjs is not staged (as companionHomeFor is). `conversation` leaves the level alone.
 */
export const CALL_EFFORTS = Object.freeze(["conversation", "low", "medium", "high"]);
export const DEFAULT_CALL_EFFORT = "medium";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const text = value => ({ type: "text", text: value });
const voice = value => `[voice] ${value}`;
/** Characters that take time to say: not spaces, punctuation or [performance tags] the voice acts out. */
export function spokenLength(value) {
  return String(value).replace(/\[[^\]]*\]/gu, "").replace(/[\s\p{P}\p{S}]/gu, "").length;
}
/** Spoken characters per second of this voice, from replies that played to the end. */
export function spokenPerSecond(pace = []) {
  let spoken = 0, seconds = 0;
  for (const item of Array.isArray(pace) ? pace : []) {
    if (typeof item?.text !== "string" || !(item.seconds > 0)) continue;
    spoken += spokenLength(item.text); seconds += item.seconds;
  }
  return seconds >= 2 && spoken > 0 ? spoken / seconds : DEFAULT_SPOKEN_PER_SECOND;
}
/**
 * The words of `value` heard in `seconds` at `perSecond`, ending on a word boundary, or null when it
 * was heard to the end. A word the voice had not finished is not heard.
 */
export function heardPrefix(value, seconds, perSecond) {
  const budget = Math.max(0, seconds) * perSecond;
  let spoken = 0, boundary = 0, tag = false;
  for (let at = 0; at < value.length; at++) {
    const char = value[at];
    if (char === "[") tag = true;
    if (tag) { if (char === "]") tag = false; continue; }
    if (/\s/u.test(char)) { boundary = at; continue; }
    if (/[\p{P}\p{S}]/u.test(char)) continue;
    // A tag right before the unheard word was never acted out; it goes with that word.
    if (++spoken > budget) return value.slice(0, boundary).replace(/(?:\s*\[[^\]]*\])+\s*$/u, "").trimEnd();
  }
  return null;
}
const sameWords = value => String(value).replace(/\s+/g, " ").trim();
const optionalText = file => { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } };
const messageText = message => typeof message?.content === "string" ? message.content.trim()
  : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("").trim();

/** Only stable sentences leave a replaceable partial-JSON snapshot; decimals are not sentences. */
export function stableSentenceCut(value) {
  for (let at = 0; at < value.length; at++) {
    const char = value[at];
    if (char === "\n") return at + 1;
    if (!".!?…。！？".includes(char)) continue;
    const next = value[at + 1];
    if (next === undefined) return -1;
    if (char === "." && /\d/u.test(value[at - 1] ?? "") && /\d/u.test(next)) continue;
    if (/[\s"'”’)\]}】」』]/u.test(next)) {
      let end = at + 2;
      while (end < value.length && /[\s"'”’)\]}】」』]/u.test(value[end])) end++;
      return end;
    }
  }
  return -1;
}

export function callConfig(env = process.env) {
  const config = JSON.parse(env.RUBATO_COMPANION_CALL || "{}");
  if (!config.enabled) return { enabled: false };
  const host = config.host ?? "127.0.0.1";
  const port = config.port;
  if (!LOOPBACK.has(host) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError("A companion call needs a loopback host and a port");
  return { ...config, host, port };
}

/** Every stateful object lives in this factory, never in a shared module-global singleton. */
export function createCompanionCall(pi, { env = process.env, config = callConfig(env), onError = () => {} } = {}) {
  const home = companionHomeFor(env);
  const bootId = randomUUID();
  const stateDir = path.join(home, config.stateDir ?? "call");
  const transcriptDir = path.join(home, config.transcriptDir ?? "call/transcripts");
  const timeoutMs = Math.max(1000, config.turnTimeoutMs ?? 180_000);
  let server, ctx, active, call, starting, closed = false, briefed = false, admission = Promise.resolve();
  let briefTransport = null;
  const completed = new Map();
  // call_say written while no heard line holds the call: after the first words of an answer, while
  // the companion keeps working. Keyed by content index; each goes out on the open call's stream.
  const between = new Map();
  // The companion's recent call_say words that played, newest last, to find the one a cut stopped.
  const spoken = [];
  // call_say ids cut off mid-way → the words heard. Every request reads them back that way, the same
  // each time, so a cut changes the cached prompt once. On disk, so a restart reads them the same.
  const cutsFile = path.join(stateDir, "cuts.json");
  const cuts = new Map();
  try { for (const [id, heard] of JSON.parse(readFileSync(cutsFile, "utf8"))) cuts.set(id, heard); } catch {}
  const timers = new Set();
  const safe = file => {
    if (!landsInside(home, file)) throw new Error("Call state must stay inside its companion home");
    return file;
  };
  function writeJson(file, value, exclusive = false) {
    safe(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (exclusive) return writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  }
  const ledgerFile = id => path.join(stateDir, "turns", `${createHash("sha256").update(id).digest("hex")}.json`);
  // The level the conversation had before a call lowered it. It is on disk so an engine that stops
  // mid-call puts the level back when this conversation starts again.
  const effortFile = path.join(stateDir, "effort.json");
  function callEffort() {
    try {
      const effort = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))?.call?.effort;
      return CALL_EFFORTS.includes(effort) ? effort : DEFAULT_CALL_EFFORT;
    } catch { return DEFAULT_CALL_EFFORT; }
  }
  function restoreEffort() {
    let saved;
    try { saved = JSON.parse(readFileSync(safe(effortFile), "utf8")); } catch { return; }
    try {
      // A level the person picked during the call stays; only the call's own level is undone.
      if (typeof saved?.restoreTo === "string" && (!saved.during || pi.getThinkingLevel() === saved.during))
        pi.setThinkingLevel(saved.restoreTo);
    } catch (error) { onError(error); }
    rmSync(effortFile, { force: true });
  }
  function enterCallEffort() {
    const level = callEffort();
    if (level === "conversation") return;
    try {
      const before = pi.getThinkingLevel();
      if (!before || before === level) return;
      writeJson(effortFile, { restoreTo: before });
      pi.setThinkingLevel(level);
      writeJson(effortFile, { restoreTo: before, during: pi.getThinkingLevel() });
    } catch (error) { onError(error); }
  }
  function transcript(role, value) {
    if (config.recordTranscripts === false || !value.trim()) return;
    try {
      const file = safe(path.join(transcriptDir, `${localDate()}.md`));
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `- ${localTime()} ${role}: ${value.replace(/\n+/g, " ").trim()}\n`, { mode: 0o600 });
    } catch (error) { onError(error); }
  }
  function system(value, { triggerTurn = false, messageId = randomUUID(), deliverAs } = {}) {
    const details = { v: 1, messageId, kind: "wake", what: "call",
      from: { sessionId: "rubato", title: "Rubato", cwd: "" }, text: value };
    pi.sendMessage({ customType: SESSION_MESSAGE_TYPE, content: buildEnvelope(details), details, display: false },
      { triggerTurn, ...(deliverAs ? { deliverAs } : {}) });
    return messageId;
  }
  function event(turn, value) {
    try { if (!turn.closed && !turn.response.destroyed) turn.response.write(JSON.stringify(value) + "\n"); }
    catch (error) { onError(error); }
  }
  function finish(turn, reason, status = "completed") {
    if (turn.closed) return;
    if (active === turn) active = undefined;
    clearTimeout(turn.timer);
    const result = reason ? { t: "error", message: reason }
      : { t: "done", text: turn.said.trim(), source: turn.said.trim() ? CALL_SAY_TOOL
        : turn.wait ? CALL_WAIT_TOOL : turn.passed ? CALL_PASS_TOOL : "none",
        toolsBeforeSay: turn.toolsBeforeSay,
        ...(turn.wait ? { waitMs: turn.wait.afterMs, waitReason: turn.wait.reason } : {}) };
    event(turn, result);
    turn.closed = true;
    if (turn.said.trim() && turn.sayId) noteSpoken(turn.sayId, turn.said);
    if (turn.said.trim()) transcript(config.companionLabel || env.RUBATO_COMPANION_TITLE || "companion", turn.said.trim());
    try { writeJson(turn.file, { ...turn.receipt, status, result, endedAt: Date.now() }); } catch (error) { onError(error); }
    turn.response.end();
  }
  function endCall() {
    if (!call) return false;
    const current = call; call = undefined; briefed = false; briefTransport = null;
    clearInterval(current.timer);
    try { clearCapability("call", current.owner, env); } catch (error) { onError(error); }
    // Hanging up ends what the call hears, not what the companion is doing.
    if (active) finish(active, "call ended", "interrupted");
    between.clear();
    restoreEffort();
    try {
      system(`[voice] 통화 종료 (약 ${Math.max(1, Math.round((Date.now() - current.startedAt) / 1000))}초)`,
        ctx?.isIdle?.() === false ? { deliverAs: "nextTurn" } : {});
    } catch (error) { onError(error); }
    current.response.end();
    return true;
  }
  /** The sentences of a growing call_say text that are new and stable; all the rest when final. */
  function newSentences(held, value, final) {
    held.latest = value;
    const sentences = [];
    if (!value.startsWith(held.committed)) return sentences;
    for (;;) {
      const pending = value.slice(held.committed.length);
      const cut = final ? pending.length : stableSentenceCut(pending);
      if (cut <= 0) return sentences;
      const sentence = pending.slice(0, cut);
      held.committed += sentence; sentences.push(sentence);
      if (final) return sentences;
    }
  }
  function commit(turn, index, value, final) {
    const held = turn.seen.get(index) ?? { committed: "", latest: "" };
    turn.seen.set(index, held);
    for (const sentence of newSentences(held, value, final)) {
      turn.said += sentence;
      event(turn, { t: "delta", text: sentence });
    }
  }
  function noteSpoken(id, value) {
    spoken.push({ id, text: value });
    if (spoken.length > 20) spoken.shift();
  }
  /**
   * The person cut in: what they heard of the companion's last words decides how that call_say reads
   * from now on. `said` is the words the call client was playing, `heardSeconds` how long they played
   * before the person was talking, `pace` replies that played in full, to measure the voice by.
   */
  function noteCut(cut) {
    const said = sameWords(cut?.said ?? "");
    if (!said || !(cut.heardSeconds >= 0)) return;
    const head = said.slice(0, 24);
    const words = [...spoken].reverse().find(item => sameWords(item.text).startsWith(head));
    if (!words || cuts.has(words.id)) return;
    const heard = heardPrefix(words.text.trim(), cut.heardSeconds, spokenPerSecond(cut.pace));
    if (heard === null) return;
    cuts.set(words.id, heard);
    while (cuts.size > CUTS_KEPT) cuts.delete(cuts.keys().next().value);
    try { writeJson(cutsFile, [...cuts]); } catch (error) { onError(error); }
  }
  /** What the companion reads back of its own call_say: only the words heard, then the cut mark. */
  function readBack(messages) {
    if (!cuts.size) return messages;
    let changed = false;
    const next = messages.map(message => {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
      let touched = false;
      const content = message.content.map(block => {
        if (block?.type !== "toolCall" || block.name !== CALL_SAY_TOOL || !cuts.has(block.id)) return block;
        touched = true;
        return { ...block, arguments: { ...block.arguments, text: `${cuts.get(block.id)}${CUT_MARK}` } };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? next : messages;
  }
  function callEvent(value) {
    try { if (call && !call.response.destroyed) call.response.write(JSON.stringify(value) + "\n"); }
    catch (error) { onError(error); }
  }
  /**
   * Words between heard lines go out on the open call's stream as `say` sentences and a `say_end`,
   * the call client plays them as they come. Returns whether a call was open to carry them.
   */
  function sayBetween(index, value, final, id) {
    if (!call) return false;
    let held = between.get(index);
    if (!held) { held = { sayId: randomUUID(), committed: "", latest: "" }; between.set(index, held); }
    for (const text of newSentences(held, value, final)) callEvent({ t: "say", sayId: held.sayId, text });
    if (!final) return true;
    between.delete(index);
    callEvent({ t: "say_end", sayId: held.sayId });
    if (held.committed.trim() && id) noteSpoken(id, held.committed);
    if (held.committed.trim()) transcript(config.companionLabel || env.RUBATO_COMPANION_TITLE || "companion", held.committed.trim());
    authorize(id, CALL_SAY_TOOL);
    return true;
  }
  function authorize(id, name) {
    if (!id) return;
    completed.set(id, name);
    const timer = setTimeout(() => { completed.delete(id); timers.delete(timer); }, 30_000);
    timer.unref?.(); timers.add(timer);
  }
  function waitIntent(args) {
    return Number.isInteger(args?.after_seconds) && args.after_seconds >= CALL_WAIT_SECONDS.min
      && args.after_seconds <= CALL_WAIT_SECONDS.max && typeof args.reason === "string" && args.reason.trim()
      ? { afterMs: args.after_seconds * 1000, reason: args.reason.trim() } : undefined;
  }
  function completeTool(turn, name, args, id, index = 0) {
    if (name === CALL_SAY_TOOL) {
      if (typeof args?.text !== "string" || !args.text.trim()) return false;
      commit(turn, index, args.text, true);
      turn.sayId = id;
    } else {
      if (turn.kind !== "opportunity") return false;
      if (name === CALL_WAIT_TOOL) { turn.wait = waitIntent(args); if (!turn.wait) return false; }
      else if (name === CALL_PASS_TOOL) turn.passed = true;
      else return false;
    }
    authorize(id, name); finish(turn); return true;
  }
  function brief(transport) {
    const own = optionalText(config.briefFile);
    const tone = optionalText(config.voiceToneFile);
    return [own || [
      "[통화 시작] 사용자가 목소리로 이 대화에 말을 걸고 있어.",
      "`call_say`에 넣은 말만 통화로 나가. 평문은 혼잣말이고 앱·텔레그램 답장과 통화는 별개야.",
      "통화가 열려 있는 동안 `call_say`는 언제든 나가. 말하고, 도구로 일하다가, 또 말해도 돼. 일하는 중에 들어온 사용자 말은 채팅처럼 하던 일 사이에 끼어 와.",
      transport === "qwen" ? "음성 계층이 말차례와 끼어들기를 맡아. 네 말은 안전한 차례에 재생돼."
        : "완성한 문장부터 사용자의 스피커로 나가. 소리로 자연스럽게 들릴 문장으로 말해.",
      "기억과 도구는 이 대화의 것을 그대로 써.",
      `사용자가 네 말 중간에 끼어들면, 네 call_say는 들린 데까지만 남고 끝에 ${CUT_MARK}가 붙어.`,
      // How a companion keeps a call going and what it does with a quiet line is its own, in its
      // voice tone file (config.voiceToneFile) or its prompt; said here too, it pushed twice.
    ].join("\n"), tone].filter(Boolean).join("\n\n");
  }
  async function body(request) {
    const parts = []; let size = 0;
    for await (const part of request) {
      size += part.length;
      if (size > CALL_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
      parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); }
    catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
  }
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const stream = response => {
    response.socket?.setNoDelay(true);
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    response.flushHeaders();
  };
  async function handle(request, response) {
    try {
      if (config.token && request.headers.authorization !== `Bearer ${config.token}`) return json(response, 401, { error: "unauthorized" });
      const url = new URL(request.url, "http://local");
      if (request.method === "GET" && url.pathname === "/call/health") {
        const health = { ok: true, runtime: "pi", sessionId: ctx?.sessionManager?.getSessionId?.(),
          model: ctx?.model?.id, contextTokens: ctx?.getContextUsage?.()?.tokens,
          busy: Boolean(active) || ctx?.isIdle?.() === false, briefed, briefTransport };
        if (url.searchParams.get("watch") !== "1") return json(response, 200, health);
        const id = url.searchParams.get("callId")?.trim();
        if (!id) return json(response, 422, { error: "callId is required" });
        endCall(); stream(response);
        call = { id, owner: randomUUID(), response, startedAt: Date.now() };
        renewCapability("call", call.owner, { env });
        enterCallEffort();
        response.write(JSON.stringify({ ...health, callId: id }) + "\n");
        const current = call;
        current.timer = setInterval(() => {
          try {
            renewCapability("call", current.owner, { env });
            if (!current.response.destroyed) current.response.write(JSON.stringify({ t: "heartbeat", at: Date.now() }) + "\n");
          }
          catch (error) { onError(error); if (call === current) endCall(); }
        }, 45_000);
        current.timer.unref?.();
        response.on("close", () => { if (call === current) endCall(); });
        return;
      }
      if (request.method !== "POST") return json(response, 404, { error: "not found" });
      const input = await body(request);
      if (url.pathname === "/call/end") return json(response, 200,
        { ok: true, ended: !input.callId || input.callId === call?.id ? endCall() : false });
      if (url.pathname === "/call/cancel") {
        const turn = active;
        const cancelled = Boolean(turn && input.turnId && turn.clientId === input.turnId);
        // The person's words stop; the companion's work goes on, as when they type over it in chat.
        if (cancelled) finish(turn, "cancelled by call client", "interrupted");
        return json(response, 200, { ok: true, cancelled });
      }
      const opportunity = url.pathname === "/call/opportunity";
      if (!opportunity && !["/call/turn", "/call/qwen-turn"].includes(url.pathname)) return json(response, 404, { error: "not found" });
      const heard = typeof input.text === "string" ? input.text.trim() : "";
      const cut = !opportunity && input.cut && typeof input.cut === "object" ? input.cut : null;
      if (!opportunity && !heard) return json(response, 422, { error: "text is required" });
      if (opportunity && (!call || active || ctx?.isIdle?.() === false))
        return json(response, 409, { error: "no idle active call for an opportunity" });
      const clientId = typeof input.turnId === "string" && input.turnId.trim() ? input.turnId.trim() : randomUUID();
      const file = safe(ledgerFile(clientId));
      let receipt;
      try { receipt = JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const digest = createHash("sha256").update(`${opportunity}:${heard}:${JSON.stringify(cut)}`).digest("hex");
      if (receipt) {
        if (receipt.digest !== digest) return json(response, 409, { error: "turnId was already used for different input" });
        // Speech already emitted cannot be unspoken. Reconnection never repeats that human turn
        // or replays its audible text, even if the process ended before the last receipt.
        stream(response);
        response.end(JSON.stringify({ t: "done", text: "", source: "none", duplicate: true,
          previousStatus: receipt.bootId === bootId ? receipt.status : "interrupted" }) + "\n");
        return;
      }
      // A newer line steers into the work in progress, as a message does in chat; nothing is aborted.
      if (active) finish(active, "superseded by a new call turn", "interrupted");
      const transport = url.pathname === "/call/qwen-turn" ? "qwen" : "standard";
      const messageId = randomUUID();
      const prompt = opportunity ? [
        "[voice] 통화는 열려 있고 사용자는 조용해.",
        typeof input.reason === "string" && input.reason.trim() ? `상황: ${input.reason.slice(0, 500)}` : "",
        "할 말이 있으면 call_say, 지금은 조용히 두는 게 맞으면 call_pass. 평문은 소리로 나가지 않아.",
      ].filter(Boolean).join("\n") : voice(heard);
      if (cut) noteCut(cut);
      receipt = { clientId, digest, bootId, status: "running", sessionId: ctx?.sessionManager?.getSessionId?.(), startedAt: Date.now() };
      writeJson(file, receipt, true);
      stream(response);
      const turn = { clientId, file, receipt, messageId, prompt, kind: opportunity ? "opportunity" : "reply",
        response, closed: false, armed: false, said: "", seen: new Map(), toolsBeforeSay: [] };
      active = turn;
      turn.timer = setTimeout(() => { if (active === turn) finish(turn, "call turn timed out", "interrupted"); }, timeoutMs);
      response.on("close", () => { if (active === turn) finish(turn, undefined, "interrupted"); });
      if (!briefed) { system(brief(transport)); briefed = true; }
      briefTransport = transport;
      if (opportunity) system(prompt, { messageId, triggerTurn: true, deliverAs: "steer" });
      else {
        noteCompanionActivity({ env });
        transcript(config.userLabel || "user", heard);
        pi.sendUserMessage(prompt, { deliverAs: "steer" });
      }
    } catch (error) {
      onError(error);
      if (active?.response === response) finish(active, error.message, "interrupted");
      else if (!response.headersSent) json(response, error.status ?? 500, { error: error.message });
      else response.end();
    }
  }
  function register(name, properties, required, description) {
    pi.registerTool({ name, label: name === CALL_SAY_TOOL ? "Speak on the call" : name === CALL_WAIT_TOOL ? "Wait on the call" : "Yield the call",
      exposure: "direct", description,
      parameters: { type: "object", additionalProperties: false, properties, required },
      async execute(id, args) {
        if (completed.get(id) === name) { completed.delete(id); return { terminate: true, content: [text("Delivered on the call.")] }; }
        const turn = active;
        // The person spoke again while another step was running: their newer line is queued behind
        // this step and its turn listens once that line enters. Words written before it answer only
        // the older line, which the call client already cancelled, so they stay unspoken.
        if (turn?.kind === "reply" && !turn.armed)
          return { isError: true, content: [text("Not spoken: the person kept talking, and their newer line comes in right after this. Answer that line with call_say; it can carry what you meant to say here.")] };
        // Between heard lines a call_say goes straight out while the call is open. The stream
        // usually carried it already; this covers a model whose stream showed no tool call.
        if (!turn && name === CALL_SAY_TOOL) {
          if (typeof args?.text !== "string" || !args.text.trim()) return { isError: true, content: [text("Nothing to say.")] };
          if (!sayBetween(`run:${id}`, args.text, true, null)) return { isError: true, content: [text("No call is open, so nothing was spoken.")] };
          return { terminate: true, content: [text("Delivered on the call.")] };
        }
        if (!turn || !turn.armed || !completeTool(turn, name, args, id))
          return { isError: true, content: [text("No matching call turn is listening for this action.")] };
        completed.delete(id);
        return { terminate: true, content: [text("Delivered on the call.")] };
      } });
  }
  register(CALL_SAY_TOOL, { text: { type: "string", minLength: 1 } }, ["text"],
    "Speak on this conversation's live call. Only these explicit words reach the speaker; ordinary text stays private. Complete sentences stream as you write. No markdown or lists. Works whenever a call is open: speak, keep working with other tools, and speak again.");
  register(CALL_WAIT_TOOL, { after_seconds: { type: "integer", minimum: CALL_WAIT_SECONDS.min, maximum: CALL_WAIT_SECONDS.max },
    reason: { type: "string", minLength: 1 } }, ["after_seconds", "reason"],
    "During a machine-opened call opportunity only, ask for another opportunity after 5–300 seconds for a concrete reason. It emits no speech.");
  register(CALL_PASS_TOOL, {}, [], "During a machine-opened call opportunity only, yield silently. It emits no speech.");
  const RING_RESULTS = {
    active: "They picked up. The call is open, and you get the first turn to speak in a moment.",
    declined: "They declined the call.",
    missed: "No answer. The call was missed.",
  };
  pi.registerTool({ name: CALL_USER_TOOL, label: "Call the person", exposure: "direct",
    description: "Ring the person for a live voice call, on their phone and desktop at once. Call whenever a voice call is what you want; the timing is yours. Waits while it rings and returns whether they picked up, declined or missed it. When they pick up you speak first.",
    parameters: { type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { type: "string", minLength: 1, description: "Why you are calling, for your own opening line." } } },
    async execute(_id, args, signal) {
      const companion = env.RUBATO_COMPANION_ID || "segno";
      let answer;
      try {
        const response = await fetch(`${env.RUBATO_CALL_CONTROL || CALL_CONTROL}/ring`, { method: "POST", signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ companion, reason: String(args?.reason ?? "") }) });
        answer = await response.json();
        if (!response.ok) return { isError: true, content: [text(`Could not ring: ${answer.error ?? response.status}`)] };
      } catch (error) {
        return { isError: true, content: [text(`Could not ring: the call service is not running (${error.message})`)] };
      }
      const result = RING_RESULTS[answer.status] ?? `The call ended as ${answer.status}.`;
      // Ending the turn on a pickup frees the conversation for the opening the call worker asks for.
      return { ...(answer.status === "active" ? { terminate: true } : {}), content: [text(result)] };
    } });
  async function start(context) {
    ctx = context; briefed = false; briefTransport = null;
    // A call that was open when the engine stopped left its lowered level behind.
    if (!call) restoreEffort();
    if (server?.listening || starting || closed) return starting;
    starting = new Promise(resolve => {
      server = createServer((request, response) => {
        response.on("error", onError);
        if (request.method === "POST") admission = admission.then(() => handle(request, response)).catch(onError);
        else void handle(request, response);
      });
      server.on("error", error => { onError(error); ctx?.ui?.notify?.(`Call bridge: ${error.message}`, "error"); resolve(); });
      server.listen(config.port, config.host, resolve);
    }).finally(() => { starting = undefined; });
    return starting;
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (active) finish(active, "companion session is closing", "interrupted");
    endCall();
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); completed.clear();
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  pi.on("session_start", (_event, context) => start(context));
  pi.on("context", event => {
    const messages = readBack(event.messages);
    if (messages !== event.messages) return { messages };
  });
  pi.on("session_shutdown", close);
  pi.on("session_compact", (_event, context) => { ctx = context; briefed = false; briefTransport = null; });
  pi.on("message_start", (event, context) => {
    ctx = context;
    if (event.message?.role === "assistant") between.clear();
    const turn = active;
    if (!turn) return;
    if (event.message?.role === "user") {
      if (turn.kind === "reply" && messageText(event.message) === turn.prompt) turn.armed = true;
      else if (turn.armed) finish(turn, "another user message owns the conversation", "interrupted");
    } else if (event.message?.customType === SESSION_MESSAGE_TYPE && turn.kind === "opportunity"
      && event.message.details?.messageId === turn.messageId) turn.armed = true;
  });
  pi.on("message_update", (event, context) => {
    ctx = context;
    const turn = active, stream = event.assistantMessageEvent;
    if (!stream) return;
    // No heard line holds the call: words go out between turns. A newer line that has not entered
    // yet holds it (turn not armed), and words written before it answer only the older line.
    if (!turn) {
      if (stream.type === "toolcall_delta") {
        const block = stream.partial?.content?.[stream.contentIndex];
        if (block?.name === CALL_SAY_TOOL && typeof block.arguments?.text === "string")
          sayBetween(stream.contentIndex, block.arguments.text, false);
      } else if (stream.type === "toolcall_end" && stream.toolCall?.name === CALL_SAY_TOOL
        && typeof stream.toolCall.arguments?.text === "string" && stream.toolCall.arguments.text.trim())
        sayBetween(stream.contentIndex, stream.toolCall.arguments.text, true, stream.toolCall.id);
      return;
    }
    if (!turn.armed || turn.closed) return;
    if (stream.type.startsWith("thinking_")) {
      eventTiming(turn, stream.type, { contentIndex: stream.contentIndex }); return;
    }
    if (stream.type === "toolcall_delta") {
      const block = stream.partial?.content?.[stream.contentIndex];
      if (block?.name !== CALL_SAY_TOOL || typeof block.arguments?.text !== "string") return;
      if (!turn.firstChar) { turn.firstChar = true; eventTiming(turn, "call_say_first_char"); }
      commit(turn, stream.contentIndex, block.arguments.text, false);
    } else if (stream.type === "toolcall_end" && CALL_TOOLS.includes(stream.toolCall?.name))
      completeTool(turn, stream.toolCall.name, stream.toolCall.arguments, stream.toolCall.id, stream.contentIndex);
  });
  function eventTiming(turn, kind, more = {}) { event(turn, { t: "timing", kind, at: Date.now(), ...more }); }
  for (const kind of ["tool_execution_start", "tool_execution_end"]) pi.on(kind, event => {
    if (!active?.armed || CALL_TOOLS.includes(event.toolName)) return;
    if (kind === "tool_execution_start") active.toolsBeforeSay.push(event.toolName);
    eventTiming(active, kind, { toolName: event.toolName, toolCallId: event.toolCallId, ...(event.isError ? { isError: true } : {}) });
  });
  pi.on("agent_settled", () => {
    const turn = active;
    if (!turn?.armed) return;
    for (const [index, held] of turn.seen) commit(turn, index, held.latest, true);
    finish(turn);
  });
  return { start, close, address: () => server?.address(), get active() { return active; } };
}

export function createCompanionCallFactories({ env = process.env } = {}) {
  const config = callConfig(env);
  return config.enabled ? [{ name: "companion-call", factory: pi => { createCompanionCall(pi, { env, config }); } }] : [];
}
