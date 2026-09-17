// Live task rows reuse the footer Speed Index formula against bundled v0 cells.
// Local v1 overlay stays in the harness store; the widget only needs a number
// that reads as `Speed N`, not decode TPS.

const MATCHED_CAP = 200

// Supported cells from harness/rubato-pi/data/speed-index-baseline-v0.json.
const BUNDLED_MEDIAN_MS: Readonly<Record<string, number>> = {
  "16384:32768:gte50": 8543.617749999998,
  "16384:32768:lt50": 9419.342207999998,
  "32768:65536:gte50": 8864.371583500411,
  "32768:65536:lt50": 8671.940624999814,
  "65536:131072:gte50": 8658.089124999999,
  "65536:131072:lt50": 11380.818082999962,
  "131072:262144:gte50": 9082.727791000158,
  "131072:262144:lt50": 12771.119833000004,
  "262144:524288:gte50": 8110.535937500186,
}

export function taskSpeedCellKey(fullInputTokens: number, cacheHitRate: number): string | undefined {
  if (!Number.isFinite(fullInputTokens) || fullInputTokens < 0) return undefined
  if (!Number.isFinite(cacheHitRate) || cacheHitRate < 0) return undefined
  const band = fullInputTokens < 1
    ? { lo: 0, hi: 1 }
    : { lo: 2 ** Math.floor(Math.log2(fullInputTokens)), hi: 2 ** (Math.floor(Math.log2(fullInputTokens)) + 1) }
  return `${band.lo}:${band.hi}:${cacheHitRate < 0.5 ? "lt50" : "gte50"}`
}

export function taskSpeedRatio(durationMs: number, fullInputTokens: number, cacheHitRate: number): number | undefined {
  if (!(durationMs > 0)) return undefined
  const key = taskSpeedCellKey(fullInputTokens, cacheHitRate)
  if (key === undefined) return undefined
  const medianMs = BUNDLED_MEDIAN_MS[key]
  if (!(medianMs > 0)) return undefined
  return medianMs / durationMs
}

export function scoreTaskSpeedIndex(ratios: readonly number[]): number | undefined {
  const logs = ratios.filter((ratio) => Number.isFinite(ratio) && ratio > 0).map((ratio) => Math.log(ratio))
  if (logs.length === 0) return undefined
  const sorted = [...logs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid]
  if (median === undefined || !Number.isFinite(median)) return undefined
  return Math.round(100 * Math.exp(median))
}

export function rememberTaskSpeedRatio(ratios: number[], ratio: number | undefined): number[] {
  if (ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) return ratios
  const next = [...ratios, ratio]
  return next.length > MATCHED_CAP ? next.slice(-MATCHED_CAP) : next
}

export function formatSpeedIndexLabel(score: number | undefined): string | undefined {
  if (score === undefined || !Number.isFinite(score)) return undefined
  return `Speed ${Math.round(score)}`
}
