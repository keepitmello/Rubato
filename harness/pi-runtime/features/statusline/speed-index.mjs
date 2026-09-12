/** Display helper only. Live scoring/recording stays omitted: it needs senpi stream hooks. */
export function formatSpeedIndex(result) {
  if (!result || result.status === "unavailable" || result.score == null) {
    return { text: "Speed —", status: "unavailable" };
  }
  return { text: `Speed ${result.score}`, status: "ready" };
}
