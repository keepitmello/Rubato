import { CURSOR_GROK_BASE_ID, shortModelLabel } from "@rubato/model-core"
import {
  excerptRendererText,
  formatLiveSpeed,
  formatStatusTarget,
  normalizeRendererText,
  parseTeamMemberTaskIdentity,
  rendererVisibleWidth,
  taskIdentityLabel,
  type ResidencyState,
  type TaskRecord,
  type TaskRunStats,
  type TaskStatus,
} from "@rubato/task"

const MAX_WIDGET_ROWS = 5
const WIDGET_LINE_MAX = 70
const LIVE_WIDGET_LINE_MAX = 220
const PROGRESS_HEAD_MAX = 60
const LIVE_TITLE_MAX = 32
export const LIVE_STATUS_REFRESH_MS = 250
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

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

// One target for every row shape: an optional preset plus the resolved model.
function recordStatusTarget(record: TaskRecord): string {
  return formatStatusTarget({
    preset: record.preset,
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
    formatLiveSpeed(stats),
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
  // Display is incidental catalog metadata. The short label keys on provider/model_id so
  // "Cursor Grok 4.7" and "cursor/grok-4.7" render as one Fast identity.
  const modelId = resolved === undefined
    ? optionalRendererText(record.model)
    : `${resolved.provider}/${resolved.model_id}`
  if (modelId === undefined) return undefined
  const effort = optionalRendererText(resolved?.reasoning)
    ?? optionalRendererText(resolved?.reasoning_effort)
  const label = formatModelWithEffort(modelId, effort)
  return label.length === 0 ? undefined : label
}

function formatModelWithEffort(modelId: string, level: string | undefined): string {
  const model = shortModelLabel(modelId)
  const effort = formatEffort(level) || effortFromModelId(modelId)
  const fast = isFastModel(modelId) ? " [fast]" : ""
  return `${effort ? `${model} ${effort}` : model}${fast}`
}

function isFastModel(modelId: string): boolean {
  const bare = modelId.split("/").pop()?.split(":", 1)[0] ?? modelId
  if (/(?:^|[-.])fast$/iu.test(bare)) return true
  // Rubato pins Cursor Grok to Fast on the wire. The planner id stays the grouped base.
  // The base is the discovery id, so it follows Cursor's namespace — `cursor-grok-4.6`
  // through 4.6, bare `grok-4.7` from 4.7 on.
  return bare === CURSOR_GROK_ID
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
