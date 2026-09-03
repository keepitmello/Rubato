import type { BeforeAgentStartEventResult } from "@code-yeongyu/senpi"
import {
  GitMemoryRepo,
  MemoryBlockCache,
  markMemoryBlock,
  normalizeProject,
  replaceMemoryBlock,
} from "@rubato/memory-core"

import { createOncePerSessionGuard } from "../task/usage-guidance"
import type { MemoryIdentityContext } from "./context"
import { estimateSystemTokens, MEMORY_PRESSURE_SOFT_RATIO } from "./status"

export const MEMORY_PROMPT_TEMPLATE = "rubato-runtime:before_agent_start:v3"
export const MEMORY_NOTICE_CUSTOM_TYPE = "rubato-memory:notice"
export const MEMORY_NUDGE_METADATA_TOKEN = "user turns since your last memory save"
export const MEMORY_COMPACT_PRIORITY_TOKEN = "After compaction:"
export const MEMORY_PRESSURE_METADATA_TOKEN = "memory pressure:"
export const MEMORY_SOUL_METADATA_TOKEN = "Soul updated by"

// Injected ONLY under the opt-in search exposure: pointing the agent at tool_search while the tools
// are directly registered sent it hunting for a tool that does not exist (session 019fe95c-09d2).
const MEMORY_TOOL_DISCOVERY_NOTE =
  'The memory tools are discoverable through tool_search: run `tool_search("memory")` once to activate them, then use them for every save.'

export interface MemoryPromptSession {
  readonly id: string
  readonly priorMessageCount: number
  readonly entries: readonly unknown[]
}

export interface MemoryPromptInjectionOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly createRepo?: (context: MemoryIdentityContext) => GitMemoryRepo
  readonly cache?: MemoryBlockCache
  readonly searchExposure?: () => boolean
  // undefined means "no advisory" — addMemoryPressureMetadata already treats it that way,
  // which lets a caller degrade to it when settings cannot be read.
  readonly resolveCompileWarnTokens?: (identity: string) => number | undefined
  readonly resolveNudgeTurns?: (
    repo: GitMemoryRepo,
    sessionId: string,
    identity: string,
  ) => Promise<number | undefined>
  readonly resolveSoulNotice?: (
    repo: GitMemoryRepo,
    sessionId: string,
    identity: string,
  ) => Promise<{ readonly sha: string } | undefined>
  /**
   * One-shot after an accepted compaction: true means this turn should carry the
   * "answer the latest user message first" guard. Callers that return true must
   * consume the pending flag so the notice fires once.
   */
  readonly resolveCompactPriorityNotice?: (sessionId: string) => boolean
  /**
   * Whitelist of system/*.md paths to project for this identity.
   * Absent or empty means metadata only — hosts that never wire it land on the safe default.
   */
  readonly resolveProject?: (identity: string) => readonly string[] | undefined
}

/**
 * Per-run memory injection. The stable projection composes with the event's systemPrompt (never
 * rebuilds it), while session-volatile recall and maintenance notices return as a late hidden
 * custom message. convertToLlm maps those to role:user; rubato-pi remaps display:false
 * customs to assistant turns before the latest user message (session 01a068e3).
 * Unbound/disabled sessions return undefined so the handler chain passes through.
 */
export function createMemoryPromptHandler(
  options: MemoryPromptInjectionOptions,
): (payload: unknown, eventCtx?: unknown) => Promise<BeforeAgentStartEventResult | undefined> {
  const cache = options.cache ?? new MemoryBlockCache()
  const createRepo = options.createRepo ?? defaultCreateRepo
  // The recall-count line is a per-session fact, not per-turn news: repeating it every turn only
  // changed the number, never the action. Nudge fires on the configured cadence, not every turn
  // after the threshold. Soul notices stay event-driven. When only the recall line would render,
  // the notice message is dropped entirely.
  const recallNoticeGuard = createOncePerSessionGuard()
  return async (payload, eventCtx) => {
    const systemPrompt = readSystemPrompt(payload)
    if (systemPrompt === undefined) return undefined
    const session = readPromptSession(eventCtx)
    if (session === undefined) return undefined
    const context = options.resolveContext(session.id)
    if (context === undefined) return undefined

    const repo = createRepo(context)
    const nudgeTurns = await options.resolveNudgeTurns?.(repo, session.id, context.identity)
    const soulNotice = await options.resolveSoulNotice?.(repo, session.id, context.identity)
    const compactPriority = options.resolveCompactPriorityNotice?.(session.id) === true
    const project = normalizeProject(options.resolveProject?.(context.identity))
    // The template stays a pure template id; the cache folds output-affecting options
    // (the project whitelist) into its own variant, so callers cannot forget to encode one.
    const block = await cache.compile(repo, `${MEMORY_PROMPT_TEMPLATE}:${context.identity}`, {
      agentId: context.identity,
      project,
    })
    // Pressure advises trimming system/ because it is expensive every turn. With an empty
    // whitelist it is not in the prompt at all, so the advice would be noise about a cost nobody pays.
    const pressureBlock = project.length > 0
      ? await addMemoryPressureMetadata(
        block,
        repo,
        options.resolveCompileWarnTokens?.(context.identity),
      )
      : block
    const composed = options.searchExposure?.() === true ? `${pressureBlock}\n\n${MEMORY_TOOL_DISCOVERY_NOTE}` : pressureBlock
    const includeRecall = !hasMemoryNotice(session.entries) && recallNoticeGuard(session.id)
    const notice = renderMemoryNotice(
      includeRecall ? session.priorMessageCount : undefined,
      nudgeTurns,
      soulNotice,
      compactPriority,
    )
    const updatedSystemPrompt = replaceMemoryBlock(
      systemPrompt,
      markMemoryBlock(context.identity, composed),
    )
    if (notice === undefined) return { systemPrompt: updatedSystemPrompt }
    return {
      systemPrompt: updatedSystemPrompt,
      message: {
        customType: MEMORY_NOTICE_CUSTOM_TYPE,
        content: notice,
        display: false,
      },
    }
  }
}

async function addMemoryPressureMetadata(
  block: string,
  repo: GitMemoryRepo,
  compileWarnTokens: number | undefined,
): Promise<string> {
  if (compileWarnTokens === undefined) return block
  const head = await repo.head()
  if (head === null) return block
  const estimate = await estimateSystemTokens(repo, head)
  const softThreshold = Math.floor(MEMORY_PRESSURE_SOFT_RATIO * compileWarnTokens)
  if (estimate < softThreshold) return block
  const percentage = Math.floor((estimate / compileWarnTokens) * 100)
  const line = `- ${MEMORY_PRESSURE_METADATA_TOKEN} system/ ~${estimate}/${compileWarnTokens} tokens (${percentage}% of advisory); trim or demote stale system/ blocks via the memory tool or run /dream`
  const metadataEnd = block.lastIndexOf("</memory_metadata>")
  if (metadataEnd < 0) return `${block}\n${line}`
  return `${block.slice(0, metadataEnd)}${line}\n${block.slice(metadataEnd)}`
}

function renderMemoryNotice(
  previousMessageCount: number | undefined,
  nudgeTurns: number | undefined,
  soulNotice: { readonly sha: string } | undefined,
  compactPriority = false,
): string | undefined {
  if (
    previousMessageCount === undefined
    && nudgeTurns === undefined
    && soulNotice === undefined
    && !compactPriority
  ) {
    return undefined
  }
  return [
    "<memory_notice>",
    ...(compactPriority
      ? [
        `- ${MEMORY_COMPACT_PRIORITY_TOKEN} the latest user message is the primary task. `
          + "Answer or act on it before status recovery, memory saves, or team reconciliation. "
          + "Do not open with a context-restored status report unless the user asked for status.",
      ]
      : []),
    ...(previousMessageCount === undefined
      ? []
      : [`- ${previousMessageCount} previous messages between you and the user are stored in recall memory`]),
    ...(nudgeTurns === undefined
      ? []
      : [
        `- ${nudgeTurns} ${MEMORY_NUDGE_METADATA_TOKEN}. `
          + "If this turn has a direct user question or request, answer or act on it first. "
          + "Memory saves are optional bookkeeping and must not delay or replace that. "
          + "Only then save durable facts, or decide nothing qualifies.",
      ]),
    ...(soulNotice === undefined
      ? []
      : [`- ${MEMORY_SOUL_METADATA_TOKEN} reflection ${soulNotice.sha.slice(0, 7)} since your last run`]),
    "</memory_notice>",
  ].join("\n")
}

function defaultCreateRepo(context: MemoryIdentityContext): GitMemoryRepo {
  return new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity })
}

function readSystemPrompt(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.type !== "before_agent_start") return undefined
  return typeof payload.systemPrompt === "string" ? payload.systemPrompt : undefined
}

function readPromptSession(eventCtx: unknown): MemoryPromptSession | undefined {
  if (!isRecord(eventCtx)) return undefined
  const manager = isRecord(eventCtx.sessionManager) ? eventCtx.sessionManager : undefined
  if (manager === undefined) return undefined
  const getSessionId = manager.getSessionId
  const getBranch = manager.getBranch
  const getEntries = manager.getEntries
  if (typeof getSessionId !== "function" || typeof getBranch !== "function") return undefined
  const id = Reflect.apply(getSessionId, manager, [])
  const branch = Reflect.apply(getBranch, manager, [])
  if (typeof id !== "string" || id.length === 0 || !Array.isArray(branch)) return undefined
  const entries = typeof getEntries === "function" ? Reflect.apply(getEntries, manager, []) : []
  return { id, priorMessageCount: branch.length, entries: Array.isArray(entries) ? entries : [] }
}

function hasMemoryNotice(entries: readonly unknown[]): boolean {
  return entries.some((entry) =>
    isRecord(entry)
    && entry.type === "custom_message"
    && entry.customType === MEMORY_NOTICE_CUSTOM_TYPE
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
