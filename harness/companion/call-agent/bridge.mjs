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

export function createBridge({ url, token = null, fetch: call = globalThis.fetch }) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const post = (route, body, signal) => call(`${url}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal });

  /** Opens the call. The companion treats the call as live while this request stays open. */
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
   */
  async function* turn(text, { turnId = randomUUID(), signal } = {}) {
    const response = await post('/call/turn', { text, turnId }, signal);
    if (!response.ok) throw new Error(`call bridge answered HTTP ${response.status}: ${await response.text()}`);
    yield* ndjson(response.body);
  }

  const cancel = turnId => post('/call/cancel', { turnId }).then(response => response.json()).catch(() => null);
  return { open, turn, cancel };
}
