// Owned shim that occupies senpi's default `tps.js` slot.
//
// The footer now owns the live Speed Index segment. This installer stays
// registered so upstream Senpi TPS never returns, but it emits no end-of-turn
// notice. Timing helpers remain for offline diagnostics.
import { formatLatencyMs } from "../statusline.mjs";

/** `delay 1.2s, think 4.0s`. Offline diagnostic helper — the live notice is silent. */
export function formatNoticeLatency(timing) {
  const delay = formatLatencyMs(timing?.waitMs ?? timing?.ttftMs);
  if (!delay) return "";
  const think = timing?.thinkMs ? formatLatencyMs(timing.thinkMs) : "";
  return think ? `delay ${delay}, think ${think}` : `delay ${delay}`;
}

export function formatTpsNotice({ tokensPerSecond, cacheHitRate, elapsedSeconds, timing }) {
  const tps = `TPS ${tokensPerSecond.toFixed(1)} tok/s`;
  const cache = cacheHitRate == null ? "" : ` Cache hit ${cacheHitRate.toFixed(1)}%,`;
  const head = `${tps}.${cache} ${elapsedSeconds.toFixed(1)}s`;
  const latency = formatNoticeLatency(timing);
  return latency ? `${head}, ${latency}` : head;
}

export function turnTokensPerSecond(timing, output, elapsedSeconds) {
  return timing?.tokensPerSecond ?? output / elapsedSeconds;
}

export function installTps(pi) {
  void pi;
}

export default function tpsExtension(pi) {
  installTps(pi);
}
