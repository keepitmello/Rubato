// Reusable companion call transport, adapted from the existing Pi call bridge.
// Audio capture, STT, synthesis and playback remain the caller's capability. This bridge runs
// on the companion's own Pi conversation and emits ONLY explicit call tools, never monologue.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { companionHomeFor, landsInside, localDate, localTime, renewCapability, clearCapability, noteCompanionActivity } from "./home.mjs";
import { buildEnvelope, SESSION_MESSAGE_TYPE } from "../session-link/message.mjs";

export const CALL_SAY_TOOL = "call_say";
export const CALL_WAIT_TOOL = "call_wait";
export const CALL_PASS_TOOL = "call_pass";
export const CALL_TOOLS = Object.freeze([CALL_SAY_TOOL, CALL_WAIT_TOOL, CALL_PASS_TOOL]);
export const CALL_BODY_BYTES = 256 * 1024;
export const CALL_WAIT_SECONDS = Object.freeze({ min: 5, max: 300 });
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const text = value => ({ type: "text", text: value });
const voice = value => `[voice] ${value}`;
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
    if (turn.said.trim()) transcript(config.companionLabel || env.RUBATO_COMPANION_TITLE || "companion", turn.said.trim());
    try { writeJson(turn.file, { ...turn.receipt, status, result, endedAt: Date.now() }); } catch (error) { onError(error); }
    turn.response.end();
  }
  async function abort(turn) {
    if (!turn?.armed) return;
    try { await ctx?.abort?.(); } catch (error) { onError(error); }
    for (let at = 0; at < 40 && ctx?.isIdle?.() === false; at++)
      await new Promise(resolve => setTimeout(resolve, 50));
  }
  function endCall() {
    if (!call) return false;
    const current = call; call = undefined; briefed = false; briefTransport = null;
    clearInterval(current.timer);
    try { clearCapability("call", current.owner, env); } catch (error) { onError(error); }
    const turn = active;
    if (turn) { finish(turn, "call ended", "interrupted"); void abort(turn); }
    try {
      system(`[voice] 통화 종료 (약 ${Math.max(1, Math.round((Date.now() - current.startedAt) / 1000))}초)`,
        ctx?.isIdle?.() === false ? { deliverAs: "nextTurn" } : {});
    } catch (error) { onError(error); }
    current.response.end();
    return true;
  }
  function commit(turn, index, value, final) {
    const held = turn.seen.get(index) ?? { committed: "", latest: "" };
    held.latest = value; turn.seen.set(index, held);
    if (!value.startsWith(held.committed)) return;
    for (;;) {
      const pending = value.slice(held.committed.length);
      const cut = final ? pending.length : stableSentenceCut(pending);
      if (cut <= 0) return;
      const sentence = pending.slice(0, cut);
      held.committed += sentence; turn.said += sentence;
      event(turn, { t: "delta", text: sentence });
      if (final) return;
    }
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
      transport === "qwen" ? "음성 계층이 말차례와 끼어들기를 맡아. 네 말은 안전한 차례에 재생돼."
        : "완성한 문장부터 사용자의 스피커로 나가. 소리로 자연스럽게 들릴 문장으로 말해.",
      "기억과 도구는 이 대화의 것을 그대로 써. 사용자가 한 말과 기계가 연 기회를 구별해.",
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
        if (cancelled) { finish(turn, "cancelled by call client", "interrupted"); await abort(turn); }
        return json(response, 200, { ok: true, cancelled });
      }
      const opportunity = url.pathname === "/call/opportunity";
      if (!opportunity && !["/call/turn", "/call/qwen-turn"].includes(url.pathname)) return json(response, 404, { error: "not found" });
      const heard = typeof input.text === "string" ? input.text.trim() : "";
      if (!opportunity && !heard) return json(response, 422, { error: "text is required" });
      if (opportunity && (!call || active || ctx?.isIdle?.() === false))
        return json(response, 409, { error: "no idle active call for an opportunity" });
      const clientId = typeof input.turnId === "string" && input.turnId.trim() ? input.turnId.trim() : randomUUID();
      const file = safe(ledgerFile(clientId));
      let receipt;
      try { receipt = JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const digest = createHash("sha256").update(`${opportunity}:${heard}`).digest("hex");
      if (receipt) {
        if (receipt.digest !== digest) return json(response, 409, { error: "turnId was already used for different input" });
        // Speech already emitted cannot be unspoken. Reconnection never repeats that human turn
        // or replays its audible text, even if the process ended before the last receipt.
        stream(response);
        response.end(JSON.stringify({ t: "done", text: "", source: "none", duplicate: true,
          previousStatus: receipt.bootId === bootId ? receipt.status : "interrupted" }) + "\n");
        return;
      }
      if (active) { const previous = active; finish(previous, "superseded by a new call turn", "interrupted"); await abort(previous); }
      const transport = url.pathname === "/call/qwen-turn" ? "qwen" : "standard";
      const messageId = randomUUID();
      const prompt = opportunity ? [
        "[voice] 통화는 열려 있고 사용자는 조용해.",
        typeof input.reason === "string" && input.reason.trim() ? `다시 볼 이유: ${input.reason.slice(0, 500)}` : "",
        "지금 꺼낼 실질적인 말은 call_say, 구체적인 다음 기회는 call_wait, 아니면 call_pass로 조용히 양보해.",
        "기계가 연 기회이고 사용자 발화는 아니야. 평문은 소리로 나가지 않아.",
      ].filter(Boolean).join("\n") : voice(heard);
      receipt = { clientId, digest, bootId, status: "running", sessionId: ctx?.sessionManager?.getSessionId?.(), startedAt: Date.now() };
      writeJson(file, receipt, true);
      stream(response);
      const turn = { clientId, file, receipt, messageId, prompt, kind: opportunity ? "opportunity" : "reply",
        response, closed: false, armed: false, said: "", seen: new Map(), toolsBeforeSay: [] };
      active = turn;
      turn.timer = setTimeout(() => { if (active === turn) { finish(turn, "call turn timed out", "interrupted"); void abort(turn); } }, timeoutMs);
      response.on("close", () => {
        if (active !== turn) return;
        finish(turn, undefined, "interrupted"); void abort(turn);
      });
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
        if (!turn || !turn.armed || !completeTool(turn, name, args, id))
          return { isError: true, content: [text("No matching call turn is listening for this action.")] };
        completed.delete(id);
        return { terminate: true, content: [text("Delivered on the call.")] };
      } });
  }
  register(CALL_SAY_TOOL, { text: { type: "string", minLength: 1 } }, ["text"],
    "Speak on this conversation's live call. Only these explicit words reach the speaker; ordinary text stays private. Complete sentences stream as you write. No markdown or lists. Available only during a call turn.");
  register(CALL_WAIT_TOOL, { after_seconds: { type: "integer", minimum: CALL_WAIT_SECONDS.min, maximum: CALL_WAIT_SECONDS.max },
    reason: { type: "string", minLength: 1 } }, ["after_seconds", "reason"],
    "During a machine-opened call opportunity only, ask for another opportunity after 5–300 seconds for a concrete reason. It emits no speech.");
  register(CALL_PASS_TOOL, {}, [], "During a machine-opened call opportunity only, yield silently. It emits no speech.");
  async function start(context) {
    ctx = context; briefed = false; briefTransport = null;
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
  pi.on("session_shutdown", close);
  pi.on("session_compact", (_event, context) => { ctx = context; briefed = false; briefTransport = null; });
  pi.on("message_start", (event, context) => {
    ctx = context;
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
    if (!turn?.armed || turn.closed || !stream) return;
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
