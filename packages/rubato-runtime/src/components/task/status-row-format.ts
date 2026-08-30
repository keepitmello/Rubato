import {
  excerptRendererText,
  formatStatusTarget,
  normalizeRendererText,
  parseTeamMemberTaskIdentity,
  rendererVisibleWidth,
  taskIdentityLabel,
  type ResidencyState,
  type TaskRecord,
  type TaskRunStats,
  type TaskStatus,
} from "@rubato/senpi-task"

const MAX_WIDGET_ROWS = 5
const WIDGET_LINE_MAX = 70
const LIVE_WIDGET_LINE_MAX = 220
const PROGRESS_HEAD_MAX = 60
const LIVE_TITLE_MAX = 32
export const LIVE_STATUS_REFRESH_MS = 250
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const MODEL_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["mythos", "Mythos"],
  ["grok", "Grok"],
  ["gemini", "Gemini"],
  ["kimi", "Kimi"],
  ["gpt", "GPT"],
]

const MODEL_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["sol", "Sol"],
  ["luna", "Luna"],
  ["terra", "Terra"],
]

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "error", "cancelled", "interrupted", "lost"])

const SUSPENDED_RESIDENCIES: ReadonlySet<ResidencyState> = new Set(["persisted_only", "rpc_detached"])

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function isSuspended(record: TaskRecord): boolean {
  return SUSPENDED_RESIDENCIES.has(record.residency_state)
}

// Maps a record's residency to its user-facing status label: suspended children show `suspended`
// instead of their raw status so the row reads `status:suspended` rather than `status:running`.
function statusLabel(record: TaskRecord): string {
  return isSuspended(record) ? "suspended" : normalizeRendererText(record.status)
}

function optionalRendererText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = normalizeRendererText(value)
  return normalized.length === 0 ? undefined : normalized
}

// One target for every row shape: the shared status-line grammar (`category:<n>(<model>:<effort>)`
// | `agent:<n>(<model>:<effort>)`), so agent-routed rows read exactly like category-routed rows.
function recordStatusTarget(record: TaskRecord): string {
  return formatStatusTarget({
    category: record.category,
    agentType: record.agent_type,
    resolvedModel: record.resolved_model,
    model: record.model,
    fallbackCount: record.fallback_attempts?.length,
  }) ?? "task"
}

function progressHead(record: TaskRecord): string | undefined {
  const normalized = optionalRendererText(record.final_response)
  if (normalized === undefined) return undefined
  return excerptRendererText(normalized, PROGRESS_HEAD_MAX)
}

export function formatTaskRow(record: TaskRecord): string {
  const identity = taskIdentityLabel({ taskId: record.task_id, name: record.name, description: record.description, taskSummary: record.task_summary })
  const parts = [identity]
  if (identity !== normalizeRendererText(record.task_id)) parts.push(`(${normalizeRendererText(record.task_id)})`)
  parts.push(recordStatusTarget(record))
  parts.push(`mode:${normalizeRendererText(record.execution_mode)}`, `status:${statusLabel(record)}`)
  if (record.pid !== undefined) parts.push(`pid:${record.pid}`)
  const progress = progressHead(record)
  if (progress !== undefined) parts.push(`progress:${progress}`)
  return parts.join(" ")
}

function selectWidgetRecords(records: readonly TaskRecord[], residentTaskIds: ReadonlySet<string>): TaskRecord[] {
  const active = records.filter((record) => !isTerminal(record.status))
  const completedResidentMembers = records.filter((record) =>
    record.status === "completed"
    && residentTaskIds.has(record.task_id)
    && parseTeamMemberTaskIdentity(record) !== undefined,
  )
  return [...active, ...completedResidentMembers]
}

export function buildWidgetRows(records: readonly TaskRecord[], residentTaskIds: ReadonlySet<string> = new Set()): string[] {
  const selected = selectWidgetRecords(records, residentTaskIds)
  if (selected.length === 0) return []
  const shown = selected.slice(0, MAX_WIDGET_ROWS).map((record) => formatCompactTaskRow(record, WIDGET_LINE_MAX, true))
  const overflow = selected.length - MAX_WIDGET_ROWS
  if (overflow > 0) shown.push(`+${overflow} more`)
  return shown
}

function formatLiveBackgroundRow(
  record: TaskRecord,
  now: number,
  maxWidth: number,
  stats?: TaskRunStats,
): string {
  const frame = SPINNER_FRAMES[Math.floor(now / LIVE_STATUS_REFRESH_MS) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]
  const tokens = [
    liveTaskTitle(record),
    liveModelLabel(record),
    isSuspended(record) ? "suspended" : undefined,
    formatElapsed(record.created_at, now),
    stats?.tokens_per_second === undefined ? undefined : `${stats.tokens_per_second} tok/s`,
  ].filter((token): token is string => token !== undefined && token.length > 0)
  return excerptRendererText(`${frame} ${tokens.join(" · ")}`, maxWidth)
}

export function taskStatusDescription(record: TaskRecord): string {
  return optionalRendererText(record.task_summary)
    ?? optionalRendererText(record.description)
    ?? optionalRendererText(record.name)
    ?? normalizeRendererText(record.task_id)
}

function liveTaskTitle(record: TaskRecord): string {
  const raw = optionalRendererText(record.description)
    ?? optionalRendererText(record.task_summary)
    ?? optionalRendererText(record.name)
    ?? normalizeRendererText(record.task_id)
  const cleaned = raw
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`]+|["'`.!?]+$/gu, "")
    .trim()
  return excerptRendererText(cleaned.length === 0 ? normalizeRendererText(record.task_id) : cleaned, LIVE_TITLE_MAX)
}

function liveModelLabel(record: TaskRecord): string | undefined {
  const resolved = record.resolved_model
  const modelId = optionalRendererText(resolved?.display)
    ?? (resolved === undefined ? undefined : `${resolved.provider}/${resolved.model_id}`)
    ?? optionalRendererText(record.model)
  if (modelId === undefined) return undefined
  const effort = optionalRendererText(resolved?.reasoning)
    ?? optionalRendererText(resolved?.reasoning_effort)
  const label = formatModelWithEffort(modelId, effort)
  return label.length === 0 ? undefined : label
}

function formatModelWithEffort(modelId: string, level: string | undefined): string {
  const model = shortModelLabel(modelId)
  const effort = formatEffort(level) || effortFromModelId(modelId)
  return effort ? `${model} ${effort}` : model
}

function shortModelLabel(modelId: string): string {
  const bare = modelId.split("/").pop() ?? modelId
  const lc = bare.toLowerCase()
  const variant = variantLabel(lc)
  if (variant) return variant
  for (const [key, label] of MODEL_FAMILIES) {
    const idx = lc.indexOf(key)
    if (idx < 0) continue
    const tail = lc.slice(idx + key.length).replace(/^[-.]/u, "")
    const version = parseVersion(tail)
    return version ? `${label} ${version}` : label
  }
  const colon = bare.indexOf(":")
  return colon >= 0 ? bare.slice(0, colon) : bare
}

// A machine-local registry may report the same model as `gpt-5.6-sol` (id spelling) or `GPT-5.6 Sol`
// (friendly display name), so every non-alphanumeric run counts as a separator here. Anchoring on
// hyphen/dot alone made the rendered label depend on which spelling the catalog happened to carry.
function isVariantSeparator(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/u.test(ch)
}

function variantLabel(lc: string): string {
  for (const [key, label] of MODEL_VARIANTS) {
    const idx = lc.lastIndexOf(key)
    if (idx < 0) continue
    // Both edges must be separators: without the trailing check `solar` would render as `Sol`.
    if (!isVariantSeparator(lc[idx - 1]) || !isVariantSeparator(lc[idx + key.length])) continue
    const before = lc.slice(0, idx).replace(/[^a-z0-9]$/u, "").replace(/^gpt[^a-z0-9]/u, "")
    const version = parseVersion(before.replace(/^[a-z]+[^a-z0-9]/u, "")) || parseVersion(before)
    return version ? `${version} ${label}` : label
  }
  return ""
}

function formatEffort(level: string | undefined): string {
  if (!level || level === "off") return ""
  if (level === "xhigh") return "Xhigh"
  if (level === "max") return "Max"
  return level
}

function effortFromModelId(modelId: string): string {
  const bare = modelId.split("/").pop() ?? modelId
  const colon = bare.lastIndexOf(":")
  if (colon < 0) return ""
  return formatEffort(bare.slice(colon + 1).toLowerCase())
}

function parseVersion(tail: string): string {
  const parts: string[] = []
  let part = ""
  for (const ch of tail) {
    if (ch >= "0" && ch <= "9") {
      part += ch
    } else if ((ch === "-" || ch === ".") && part) {
      parts.push(part)
      part = ""
    } else {
      break
    }
  }
  if (part) parts.push(part)
  while (parts.length > 0 && (parts.at(-1)?.length ?? 0) >= 6) parts.pop()
  if (parts.length === 0) return ""
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`
  return parts[0] ?? ""
}

function formatElapsed(createdAt: string, now: number): string {
  const startedAt = Date.parse(createdAt)
  const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

export function backgroundWidgetRows(
  records: readonly TaskRecord[],
  _activity: ReadonlyMap<string, string>,
  now: number,
  liveStats?: (taskId: string) => TaskRunStats | undefined,
  maxWidth = LIVE_WIDGET_LINE_MAX,
  residentTaskIds: ReadonlySet<string> = new Set(),
): string[] {
  const selected = selectWidgetRecords(records, residentTaskIds)
  if (selected.length === 0) return []
  const boundedWidth = Number.isFinite(maxWidth) && maxWidth > 0
    ? Math.min(LIVE_WIDGET_LINE_MAX, Math.floor(maxWidth))
    : LIVE_WIDGET_LINE_MAX
  const shown = selected.slice(0, MAX_WIDGET_ROWS).map((record) =>
    record.status === "completed"
      ? formatCompactTaskRow(record, boundedWidth, true)
      : formatLiveBackgroundRow(record, now, boundedWidth, liveStats?.(record.task_id)),
  )
  const overflow = selected.length - MAX_WIDGET_ROWS
  if (overflow > 0) shown.push(`+${overflow} more`)
  return shown
}

function formatCompactTaskRow(record: TaskRecord, maxWidth: number, includeName: boolean): string {
  const context = compactTaskContext(record)
  const identityWidth = Math.max(0, maxWidth - rendererVisibleWidth(context) - 1)
  if (identityWidth === 0) return excerptRendererText(context, maxWidth)
  const identity = compactTaskIdentity(record, identityWidth, includeName)
  return excerptRendererText(`${identity}|${context}`, maxWidth)
}

function compactTaskIdentity(record: TaskRecord, maxWidth: number, includeName: boolean): string {
  if (!includeName) return excerptRendererText(record.task_id, maxWidth)
  return excerptRendererText(
    taskIdentityLabel({ taskId: record.task_id, name: record.name, description: record.description, taskSummary: record.task_summary }),
    maxWidth,
  )
}

function compactTaskContext(record: TaskRecord): string {
  return [
    excerptRendererText(recordStatusTarget(record), 46),
    excerptRendererText(record.execution_mode, 10),
    excerptRendererText(statusLabel(record), 9),
  ].filter((part): part is string => part !== undefined).join(" ")
}
