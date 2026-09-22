/**
 * Speed is computed at the provider observation boundary and carried with the
 * assistant message. Task-host/IPC arrival clocks are not provider latency.
 * A missing or unavailable snapshot must not fall back to another formula.
 * `null` is this call's explicit "no score" (shown as `Speed —`); `undefined`
 * means the message carried no snapshot at all, so the last known value stands.
 */
export function readTaskSpeedIndex(message: Record<string, unknown>): number | null | undefined {
  const value = message.rubatoSpeedIndex
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const snapshot = value as Record<string, unknown>
  if (snapshot.version !== 1 || ![1, 2].includes(snapshot.metricVersion as number)) return undefined
  if (snapshot.status === "unavailable") return null
  if (snapshot.status !== "ready" && snapshot.status !== "experimental") return undefined
  const score = snapshot.score
  return typeof score === "number" && Number.isSafeInteger(score) && score >= 0 ? score : undefined
}

export function formatSpeedIndexLabel(score: number | undefined): string | undefined {
  if (score === undefined || !Number.isFinite(score)) return undefined
  return `Speed ${Math.round(score)}`
}
