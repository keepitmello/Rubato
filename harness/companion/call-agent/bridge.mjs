// Client for the call bridge inside the companion's own session
// (harness/pi-runtime/features/companion-home/call.mjs). The bridge owns what the companion
// says; this side only carries heard text in and finished sentences out.
import { randomUUID } from 'node:crypto';

/** Lines of an NDJSON body as parsed objects. */
export async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffered.trim()) yield JSON.parse(buffered);
}

/** How long the person talks over the companion before its voice stops (LiveKit's default 0.5 s). */
export const TALK_OVER_SECONDS = 0.5;

/**
 * The companion's last reply when the person cut it off, or null when it played to the end.
 * LiveKit keeps an interrupted reply right before the person's words that cut in, marked
 * `interrupted`, with when its voice started and stopped. `said` is its text (LiveKit may keep only
 * part of it), `heardSeconds` how long it played before the person was talking, and `pace` the
 * replies of this call that played in full, to measure the voice by.
 */
export function cutFrom(items) {
  const played = item => {
    const { startedSpeakingAt: from, stoppedSpeakingAt: to } = item.metrics ?? {};
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : null;
  };
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item.type !== 'message' || item.role === 'user') continue;
    if (item.role !== 'assistant' || !item.interrupted) return null;
    const said = item.textContent?.trim();
    const seconds = played(item);
    if (!said || seconds === null) return null;
    const pace = items.slice(0, at).filter(other => other.type === 'message' && other.role === 'assistant' && !other.interrupted)
      .map(other => ({ text: other.textContent ?? '', seconds: played(other) }))
      .filter(other => other.text && other.seconds).slice(-5);
    return { said, heardSeconds: Math.max(0, seconds - TALK_OVER_SECONDS), pace };
  }
  return null;
}

/**
 * What the companion says between heard lines: after the first words of an answer, while it keeps
 * working. The bridge sends each such call_say on the open call's stream as `say` sentences and a
 * `say_end`; each becomes one text stream handed to `speak`, started only while the person is not
 * talking, in the order the companion said them.
 */
export function createSpeechBetween({ speak, onSentence = () => {}, onError = () => {} }) {
  const open = new Map();
  let quiet = Promise.resolve(), release = null;
  return {
    event(item) {
      if (item?.t === 'say' && typeof item.text === 'string') {
        let controller = open.get(item.sayId);
        if (!controller) {
          const stream = new ReadableStream({ start(own) { controller = own; } });
          open.set(item.sayId, controller);
          void quiet.then(() => speak(stream)).catch(onError);
        }
        onSentence(item.text);
        controller.enqueue(item.text);
      } else if (item?.t === 'say_end') {
        open.get(item.sayId)?.close();
        open.delete(item.sayId);
      }
    },
    /** Holds new speech while the person talks and lets it go when they stop. */
    personSpeaking(speaking) {
      if (speaking && !release) quiet = new Promise(resolve => { release = resolve; });
      else if (!speaking && release) { release(); release = null; }
    },
    close() {
      for (const controller of open.values()) { try { controller.close(); } catch {} }
      open.clear();
      release?.(); release = null;
    },
  };
}

export function createBridge({ url, token = null, fetch: call = globalThis.fetch }) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const post = (route, body, signal) => call(`${url}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal });

  /**
   * Opens the call. The companion treats the call as live while this request stays open, and what
   * it says between heard lines arrives here as `onEvent` items (see createSpeechBetween).
   */
  async function open(callId, { onEvent = () => {} } = {}) {
    const controller = new AbortController();
    const response = await call(`${url}/call/health?watch=1&callId=${encodeURIComponent(callId)}`,
      { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`call bridge answered HTTP ${response.status}`);
    const reader = ndjson(response.body);
    const first = await reader.next();
    if (first.done) throw new Error('call bridge closed before the call opened');
    const done = (async () => { try { for await (const item of reader) onEvent(item); } catch {} })();
    return {
      health: first.value,
      async end() {
        await post('/call/end', { callId }).catch(() => {});
        controller.abort();
        await done;
      },
    };
  }

  /**
   * One heard turn. Yields `{ t: 'delta', text }` sentences as the companion writes them, timing
   * events, and a final `done` or `error`. Aborting the signal cancels the turn on the bridge too.
   * `cut` is the companion's previous reply when the person cut in on it (`cutFrom`).
   */
  async function* turn(text, { turnId = randomUUID(), signal, cut = null } = {}) {
    const response = await post('/call/turn', { text, turnId, ...(cut ? { cut } : {}) }, signal);
    if (!response.ok) throw new Error(`call bridge answered HTTP ${response.status}: ${await response.text()}`);
    yield* ndjson(response.body);
  }

  /**
   * A machine-opened chance for the companion to speak first. Resolves to `{ events }` when it
   * took it, or `{ status }` when the bridge refused (409 while the companion is still busy).
   */
  async function opportunity(reason, { turnId = randomUUID() } = {}) {
    const response = await post('/call/opportunity', { reason, turnId });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    return { events: ndjson(response.body) };
  }

  const cancel = turnId => post('/call/cancel', { turnId }).then(response => response.json()).catch(() => null);
  return { open, turn, opportunity, cancel };
}
