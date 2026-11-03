// Anthropic message threads: send a long conversation once, then only what is new.
//
// A thread keeps the conversation on Anthropic's side for 5 minutes after its last request
// (beta `message-threads-2026-08-12`, https://platform.claude.com/docs/en/build-with-claude/message-threads).
// The first request (`thread: {type: "create"}`) carries everything; the next one carries only
// the messages after the previous response plus that response's id, without `system`/`tools`.
// Time to first token drops on long sessions; tokens, price and rate limits stay the same, and
// the prompt cache is shared with unthreaded requests (measured 2026-11-03 on the subscription
// token: an unthreaded full request read every token the threaded turns had cached).
//
// This wrapper sits right above the network, under every other Rubato body rewrite, so it sees
// the exact body that would go out and turns it into a create or a continue. It owns the whole
// thread lifecycle; Pi never learns that a thread exists:
//
// - Which thread: content-addressed. A state is stored under the hash of the request it answered
//   (fixed fields + every message). The next request continues it only when it is that request,
//   then the answer we streamed (same text, same tool_use ids), then something new.
// - Prompt cache: a thread cannot move a breakpoint after it was sent, and Pi moves the message
//   breakpoint to the newest user turn every request. Message breakpoints are dropped and the
//   same value goes top-level, which the API places on the newest block of every request.
// - Server compaction: Rubato's compaction edit carries its briefing `instructions`, which a
//   thread refuses (400 thread_unsupported_request). Requests near the compaction line go out
//   unthreaded with the edit untouched, so the summary keeps Rubato's guidance. Every threaded
//   request swaps the edit for the one form a thread accepts (pause, no instructions) with a
//   trigger it can never reach, so it never summarizes. Once the server has compacted, the
//   conversation stays unthreaded: the API answers a create that holds a real compaction block
//   but never stores it, so every continue would be a wasted 404 (measured 2026-11-03).
// - Anything unusual goes out exactly as today: cache-warming replays (`max_tokens: 1`), other
//   context-management edits, too many breakpoints, a create the API refuses (then this auth and
//   model stay unthreaded for the process), and the off switch.
// - Recovery: a continue the API cannot serve is resent at once as a create. When a thread
//   created on the previous turn already cannot be continued, the API is not storing this
//   conversation, and it stays unthreaded (the SDK thread helper does the same); any other 400 on a
//   threaded request is resent as today's request, whose own compaction edit rescues a prompt
//   that grew past the line. Errors come back before the model runs, so a retry costs no tokens.
// - The compaction line is judged in tokens: the previous answer's usage plus the new bytes at the
//   tokens-per-byte this conversation measured (2 bytes per token before it has been measured).
import { createHash } from "node:crypto";

export const MESSAGE_THREADS_BETA = "message-threads-2026-08-12";

/** The server keeps a thread 5 minutes after its last request; continue only well inside that. */
export const THREAD_PRESUMED_LIFETIME_MS = 270_000;

/** Requests whose estimated input reaches this share of the compaction trigger go out unthreaded. */
export const COMPACTION_ROUTE_RATIO = 0.9;

/**
 * Bytes of request JSON per token before this conversation has been measured. Low on purpose so
 * the estimate runs high: digit-heavy text measured 2.1 (Opus 5.5, 2026-11-03), code and prose
 * run 3 to 4. A measured conversation uses its own ratio.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 2;

/** A trigger a conversation never reaches: the thread-safe compact edit must not summarize. */
export const THREAD_COMPACTION_TRIGGER = 100_000_000;

const COMPACT_EDIT_TYPE = "compact_20260112";
const CLEAR_THINKING_EDIT_TYPE = "clear_thinking_20251015";
const DEFAULT_COMPACTION_TRIGGER = 150_000;
const MAX_THREAD_BREAKPOINTS = 4;
const MAX_STATES = 256;
const STATE_RETENTION_MS = 65 * 60_000;

// Fields the API requires to stay identical across a thread (a change is a 400
// thread_fingerprint_mismatch). `system` and `tools` are stored with the thread and sent on the
// create only. The authorization is part of it because a thread belongs to the account that made it.
const FIXED_FIELDS = Object.freeze([
  "model",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "mcp_servers",
  "context_management",
  "output_config",
  "container",
  "cache_control",
  "fallbacks",
]);

// A response the API stores and a later continue can build on.
const CONTINUABLE_STOP_REASONS = new Set(["end_turn", "tool_use", "stop_sequence"]);

// A thread error: the request goes out unthreaded and this account and model stay that way.
const THREAD_ERROR_CODE = /^thread_/;

export const MESSAGE_THREADS_SETTING = Symbol.for("rubato.messageThreads.enabled");

/**
 * Off switch. `RUBATO_MESSAGE_THREADS=off` wins; otherwise the user setting
 * (`providers.messageThreads` in ~/.rubato/rubato.jsonc, read by the providers extension and
 * published under `MESSAGE_THREADS_SETTING`). On when neither says otherwise.
 */
export function messageThreadsEnabled(env = process.env) {
  const raw = String(env?.RUBATO_MESSAGE_THREADS ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return false;
  if (raw === "on" || raw === "1" || raw === "true") return true;
  const setting = globalThis[MESSAGE_THREADS_SETTING];
  if (typeof setting === "function") {
    try {
      return setting() !== false;
    } catch {
      return true;
    }
  }
  return true;
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  return input?.href ?? input?.url ?? String(input);
}

function messagesUrl(url) {
  return /\/v1\/messages(\?|$)/.test(url);
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  return key === undefined ? undefined : String(headers[key]);
}

export function appendMessageThreadsBeta(headers) {
  const beta = MESSAGE_THREADS_BETA;
  if (headers && typeof headers.get === "function" && typeof headers.set === "function") {
    const current = headers.get("anthropic-beta") ?? "";
    const listed = current.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (listed.includes(beta)) return headers;
    const next = new Headers(headers);
    next.set("anthropic-beta", current ? `${current},${beta}` : beta);
    return next;
  }
  const record = isRecord(headers) ? { ...headers } : {};
  const key = Object.keys(record).find((name) => name.toLowerCase() === "anthropic-beta");
  const current = key ? String(record[key]) : "";
  const listed = current.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (listed.includes(beta)) return record;
  if (key) record[key] = current ? `${current},${beta}` : beta;
  else record["anthropic-beta"] = beta;
  return record;
}

function betaSet(headers) {
  return (readHeader(headers, "anthropic-beta") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== MESSAGE_THREADS_BETA)
    .sort();
}

function authIdentity(headers) {
  const auth = readHeader(headers, "authorization") ?? readHeader(headers, "x-api-key") ?? "";
  return sha(`auth\n${auth}`).slice(0, 32);
}

function stripCacheControl(value) {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!isRecord(value)) return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = stripCacheControl(nested);
  }
  return out;
}

function findCacheControl(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findCacheControl(value[index]);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.cache_control)) return value.cache_control;
  for (const nested of Object.values(value)) {
    const found = findCacheControl(nested);
    if (found) return found;
  }
  return undefined;
}

function countCacheControl(value) {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countCacheControl(entry), 0);
  if (!isRecord(value)) return 0;
  let count = isRecord(value.cache_control) ? 1 : 0;
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "cache_control") count += countCacheControl(nested);
  }
  return count;
}

/**
 * The compact edit a thread accepts: pause after compaction, no instructions. Its trigger is out
 * of reach, so it never summarizes; it only keeps compaction blocks already in the conversation valid.
 */
export function threadCompactionEdit() {
  return {
    type: COMPACT_EDIT_TYPE,
    pause_after_compaction: true,
    trigger: { type: "input_tokens", value: THREAD_COMPACTION_TRIGGER },
  };
}

function compactionPlan(body) {
  const management = body.context_management;
  if (management === undefined || management === null) return { ok: true, compact: undefined };
  if (!isRecord(management)) return { ok: false };
  const keys = Object.keys(management).filter((key) => key !== "edits");
  if (keys.length > 0) return { ok: false };
  const edits = Array.isArray(management.edits) ? management.edits : [];
  let compact;
  for (const edit of edits) {
    if (edit?.type === COMPACT_EDIT_TYPE && compact === undefined) {
      compact = edit;
      continue;
    }
    if (edit?.type === CLEAR_THINKING_EDIT_TYPE && edit.keep === "all") continue;
    return { ok: false };
  }
  const trigger = Number(compact?.trigger?.value);
  return {
    ok: true,
    compact,
    trigger: compact ? (Number.isFinite(trigger) && trigger > 0 ? trigger : DEFAULT_COMPACTION_TRIGGER) : undefined,
  };
}

function threadContextManagement(body, plan) {
  if (!plan.compact) return body.context_management;
  return {
    ...body.context_management,
    edits: body.context_management.edits.map((edit) => (edit === plan.compact ? threadCompactionEdit() : edit)),
  };
}

function messageDigest(message) {
  return sha(JSON.stringify(message));
}

/** prefixHashes[i] names the request made of the fixed fields and the first i messages. */
function prefixHashes(fingerprint, messages) {
  const hashes = [sha(`fingerprint\n${fingerprint}`)];
  for (const message of messages) {
    hashes.push(sha(`${hashes.at(-1)}\n${messageDigest(message)}`));
  }
  return hashes;
}

/** What an assistant turn said, in a form both the stream and Pi's replay produce. */
function assistantSignature(content) {
  const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  let text = "";
  const toolIds = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "tool_use" && typeof block.id === "string") toolIds.push(block.id);
  }
  return sha(JSON.stringify([text, toolIds]));
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function hasCompactionBlock(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === "compaction");
}

/** The API drops everything before the newest compaction block, so only the rest counts. */
function fromLastCompaction(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasCompactionBlock(messages[index])) return messages.slice(index);
  }
  return messages;
}

function errorCode(payload) {
  const details = payload?.error?.details;
  return typeof details?.error_code === "string" ? details.error_code : undefined;
}

function mentionsThread(payload) {
  return /\bthread\b/i.test(String(payload?.error?.message ?? ""));
}

function threadProblem(payload) {
  return THREAD_ERROR_CODE.test(errorCode(payload) ?? "") || mentionsThread(payload);
}

async function readErrorPayload(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { text, payload: undefined };
  }
  try {
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text, payload: undefined };
  }
}

function rebuiltResponse(response, body) {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Read the SSE stream as it passes through, untouched, and report what the thread needs:
 * the response id, what it said, why it stopped, its usage, and whether a fallback model wrote it.
 */
export function observeThreadStream(body, onComplete) {
  const decoder = new TextDecoder();
  let buffer = "";
  const seen = { id: undefined, model: undefined, text: "", toolIds: [], stopReason: undefined, usage: {}, fallback: false, stopped: false };
  const handleEvent = (raw) => {
    let data = "";
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event?.type === "message_start") {
      seen.id = event.message?.id;
      seen.model = event.message?.model;
      Object.assign(seen.usage, event.message?.usage ?? {});
    } else if (event?.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text" && typeof block.text === "string") seen.text += block.text;
      else if (block?.type === "tool_use" && typeof block.id === "string") seen.toolIds.push(block.id);
      else if (block?.type === "fallback") seen.fallback = true;
    } else if (event?.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") seen.text += event.delta.text;
    } else if (event?.type === "message_delta") {
      if (event.delta?.stop_reason) seen.stopReason = event.delta.stop_reason;
      if (isRecord(event.usage)) {
        for (const [key, value] of Object.entries(event.usage)) {
          if (value !== null && value !== undefined) seen.usage[key] = value;
        }
        const iterations = event.usage.iterations;
        if (Array.isArray(iterations) && iterations.some((entry) => /fallback/.test(String(entry?.type ?? "")))) seen.fallback = true;
      }
    } else if (event?.type === "message_stop") {
      seen.stopped = true;
    }
  };
  const drain = (final) => {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : parts.pop();
    for (const part of parts) if (part.trim()) handleEvent(part);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        buffer += decoder.decode(chunk, { stream: true });
        drain(false);
      } catch { /* observing never breaks the stream */ }
    },
    flush() {
      try {
        buffer += decoder.decode();
        drain(true);
        if (seen.stopped) onComplete(seen);
      } catch { /* observing never breaks the stream */ }
    },
  }));
}

function usageTotal(usage) {
  return ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
    .reduce((sum, key) => sum + (Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : 0), 0);
}

/**
 * The shape of one request: either `{ kind: "passthrough" }` (send the original body) or a
 * threaded plan with the body to send and what to remember once the answer is complete.
 */
export function planThreadRequest(bodyText, headers, { store, now = Date.now(), disabled = new Set() } = {}) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { kind: "passthrough", reason: "not_json" };
  }
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) return { kind: "passthrough", reason: "no_messages" };
  if (body.thread !== undefined) return { kind: "passthrough", reason: "caller_thread" };
  if (body.stream !== true) return { kind: "passthrough", reason: "not_streaming" };
  // Cache warming replays the last request with max_tokens 1. A thread would only spend the
  // response id the real next turn continues from.
  if (!(Number(body.max_tokens) > 1)) return { kind: "passthrough", reason: "cache_warm" };
  const auth = authIdentity(headers);
  if (disabled.has(`${auth}\n${body.model}`)) return { kind: "passthrough", reason: "unsupported_earlier" };
  const plan = compactionPlan(body);
  if (!plan.ok) return { kind: "passthrough", reason: "context_management" };

  const messages = stripCacheControl(body.messages);
  const cacheControl = body.cache_control ?? findCacheControl(body.messages) ?? findCacheControl(body.system);
  const threaded = { ...body, messages };
  if (cacheControl) threaded.cache_control = cacheControl;
  if (plan.compact) threaded.context_management = threadContextManagement(body, plan);
  const breakpoints = countCacheControl(threaded.system) + countCacheControl(threaded.tools) + (threaded.cache_control ? 1 : 0);
  if (breakpoints > MAX_THREAD_BREAKPOINTS) return { kind: "passthrough", reason: "cache_breakpoints" };

  const fixed = {};
  for (const field of FIXED_FIELDS) if (threaded[field] !== undefined) fixed[field] = threaded[field];
  const fingerprint = JSON.stringify({ auth, betas: betaSet(headers), fixed });
  const hashes = prefixHashes(fingerprint, messages);
  const key = hashes.at(-1);
  // One conversation, across rewrites of its later messages: tokens per byte measured on it.
  const lineage = hashes[1];
  const tokensPerByte = store.get(`ratio\n${lineage}`)?.tokensPerByte ?? 1 / BYTES_PER_TOKEN_ESTIMATE;
  const requestBytes = byteLength(fromLastCompaction(messages)) + byteLength(body.system) + byteLength(body.tools);

  // The longest earlier request this one extends: n stored messages, then its answer, then new ones.
  let previous;
  for (let n = messages.length - 2; n >= 1; n -= 1) {
    const state = store.get(hashes[n]);
    if (state && state.messageCount === n) {
      previous = state;
      break;
    }
  }

  const newMessages = previous ? messages.slice(previous.messageCount + 1) : messages;
  const answer = previous ? messages[previous.messageCount] : undefined;
  // The previous answer's usage is the server's own count, unless that answer compacted the
  // conversation; then (and with no previous request) count bytes from the newest compaction.
  const estimate = Math.ceil(previous && !hasCompactionBlock(answer)
    ? previous.usageTotal + byteLength(newMessages) * tokensPerByte
    : requestBytes * tokensPerByte);
  const measure = { lineage, requestBytes };

  const unthreaded = (reason) => ({ kind: "passthrough", reason, remember: { key, messageCount: messages.length, threaded: false, ...measure } });
  if (plan.compact && estimate >= plan.trigger * COMPACTION_ROUTE_RATIO) return unthreaded("compaction_line");
  if (messages.some(hasCompactionBlock)) return unthreaded("compacted_conversation");
  if (store.has(unstorableKey(lineage))) return unthreaded("not_stored");

  const continuable = previous
    && previous.responseId
    && !previous.continued
    && now - previous.completedAt < THREAD_PRESUMED_LIFETIME_MS
    && answer?.role === "assistant"
    && assistantSignature(answer.content) === previous.answerSignature
    && newMessages.length > 0
    && newMessages[0]?.role !== "assistant";

  const create = { ...threaded, thread: { type: "create" } };
  const remember = { key, messageCount: messages.length, threaded: true, authModel: `${auth}\n${body.model}`, model: body.model, ...measure };
  if (!continuable) {
    remember.createdBy = "create";
    return { kind: "create", bodyText: JSON.stringify(create), remember, reason: previous ? "not_continuable" : "new_conversation" };
  }
  const { system: _system, tools: _tools, ...rest } = threaded;
  const next = { ...rest, messages: newMessages, thread: { type: "continue", previous_message_id: previous.responseId } };
  return {
    kind: "continue",
    bodyText: JSON.stringify(next),
    createBodyText: JSON.stringify(create),
    previous,
    remember,
  };
}

function unstorableKey(lineage) {
  return `unstorable\n${lineage}`;
}

function pruneStore(store, now) {
  for (const [key, state] of store) {
    if (now - state.completedAt > STATE_RETENTION_MS) store.delete(key);
  }
  while (store.size > MAX_STATES) store.delete(store.keys().next().value);
}

export function createMessageThreads({ store = new Map(), disabled = new Set(), now = () => Date.now(), env = process.env } = {}) {
  const remember = (plan, seen) => {
    const at = now();
    const alive = plan.remember.threaded
      && CONTINUABLE_STOP_REASONS.has(seen.stopReason)
      && !seen.fallback
      && (seen.model === undefined || seen.model === plan.remember.model);
    store.delete(plan.remember.key);
    store.set(plan.remember.key, {
      messageCount: plan.remember.messageCount,
      responseId: alive ? seen.id : undefined,
      answerSignature: assistantSignature([
        ...(seen.text ? [{ type: "text", text: seen.text }] : []),
        ...seen.toolIds.map((id) => ({ type: "tool_use", id })),
      ]),
      usageTotal: usageTotal(seen.usage),
      completedAt: at,
      continued: false,
      createdBy: plan.remember.createdBy ?? "continue",
    });
    const input = usageTotal({ ...seen.usage, output_tokens: 0 });
    if (plan.remember.lineage && plan.remember.requestBytes > 0 && input > 0) {
      const ratioKey = `ratio\n${plan.remember.lineage}`;
      store.delete(ratioKey);
      store.set(ratioKey, { tokensPerByte: input / plan.remember.requestBytes, completedAt: at });
    }
    pruneStore(store, at);
  };

  const observed = (response, plan) => {
    if (!plan.remember || !response?.ok || !response.body) return response;
    return rebuiltResponse(response, observeThreadStream(response.body, (seen) => remember(plan, seen)));
  };

  const wrapFetch = (baseFetch, { env: callEnv = env } = {}) => {
    const inner = baseFetch ?? globalThis.fetch;
    return async (input, init = {}) => {
      const url = requestUrl(input);
      const bodyText = typeof init.body === "string" ? init.body : undefined;
      if (!messagesUrl(url) || bodyText === undefined || !messageThreadsEnabled(callEnv)) return inner(input, init);
      const plan = planThreadRequest(bodyText, init.headers, { store, now: now(), disabled });
      if (plan.kind === "passthrough") return observed(await inner(input, init), plan);

      const headers = appendMessageThreadsBeta(init.headers);
      const send = (text) => inner(input, { ...init, body: text, headers });
      const unthreadedPlan = { ...plan, remember: { ...plan.remember, threaded: false } };
      // Today's request, exactly: it carries Rubato's own compaction edit, so a prompt the thread
      // let grow past the line is compacted with Rubato's guidance instead of failing.
      const unthreaded = async (payload) => {
        if (threadProblem(payload)) disabled.add(plan.remember.authModel);
        return observed(await inner(input, init), unthreadedPlan);
      };
      const created = { ...plan, remember: { ...plan.remember, createdBy: "create" } };
      const createOrFallBack = async () => {
        const response = await send(plan.kind === "continue" ? plan.createBodyText : plan.bodyText);
        if (response.ok || response.status !== 400) return observed(response, created);
        const { payload } = await readErrorPayload(response);
        return unthreaded(payload);
      };

      if (plan.kind === "create") return createOrFallBack();

      // Each response id can be continued once: spend it now, whatever comes back.
      plan.previous.continued = true;
      const response = await send(plan.bodyText);
      if (response.ok) return observed(response, plan);
      if (response.status !== 400 && response.status !== 404) return response;
      const { text, payload } = await readErrorPayload(response);
      if (response.status === 404) {
        // A 404 for a model that does not exist is not a thread problem.
        if (errorCode(payload) !== "thread_not_found" && !mentionsThread(payload)) return rebuiltResponse(response, text);
        // Created on the previous turn, well inside its lifetime, and already gone: the API is
        // not storing this conversation. Stop paying a round trip for it every turn.
        if (plan.previous.createdBy === "create") {
          store.set(unstorableKey(plan.remember.lineage), { completedAt: now() });
          return unthreaded(undefined);
        }
        return createOrFallBack();
      }
      return threadProblem(payload) ? createOrFallBack() : unthreaded(payload);
    };
  };

  return { store, disabled, wrapFetch, plan: (bodyText, headers) => planThreadRequest(bodyText, headers, { store, now: now(), disabled }) };
}

let shared;
export function messageThreads() {
  shared ??= createMessageThreads();
  return shared;
}
