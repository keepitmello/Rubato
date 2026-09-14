// Every presentation message leaves this server as one CBOR frame. When a frame
// cannot be encoded — a lone surrogate, or more bytes than the frame limit — the
// transport closes the whole connection and each client reports "Byte transport
// closed". So payloads are repaired and bounded here, at the only boundary that
// can still choose. Inbound commands are never touched: a prompt must reach the
// worker exactly as the person typed it.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');
const KEPT = 512;

/** One reply, one state publish. Held under the 32 MiB frame the server listens with. */
export const FRAME_BUDGET = 24 * 1024 * 1024;
/** One runtime event inside the replicated state. */
export const EVENT_BUDGET = 1024 * 1024;
/** The whole rolling event window; clients resynchronise from a snapshot when it trims. */
export const EVENTS_BUDGET = 8 * 1024 * 1024;

const elide = (value, bytes) => `${value.slice(0, KEPT)}… [rubato: elided ${bytes} bytes]`;

/** JSON value, encodable text, bounded size — plus the byte cost the caller may need to track. */
export function measure(value, budget = FRAME_BUDGET) {
  const text = JSON.stringify(value ?? null);
  if (text === undefined) return { value: null, bytes: 4 };
  const carrier = { value: JSON.parse(text) };
  let bytes = Buffer.byteLength(text);
  const strings = [];
  const visit = (holder, key) => {
    const current = holder[key];
    if (typeof current === 'string') {
      if (LONE_SURROGATE.test(current)) holder[key] = current.replace(LONE_SURROGATES, '\uFFFD');
      strings.push({ holder, key, bytes: Buffer.byteLength(holder[key]) });
      return;
    }
    if (current && typeof current === 'object') for (const nested of Object.keys(current)) visit(current, nested);
  };
  visit(carrier, 'value');
  if (bytes > budget) {
    // Largest first: a transcript dies on its attachments, not on its sentences.
    strings.sort((left, right) => right.bytes - left.bytes);
    for (const item of strings) {
      if (bytes <= budget) break;
      const replacement = elide(item.holder[item.key], item.bytes);
      bytes -= item.bytes - Buffer.byteLength(replacement);
      item.holder[item.key] = replacement;
    }
  }
  return { value: carrier.value, bytes };
}

export const wire = (value, budget = FRAME_BUDGET) => measure(value, budget).value;
