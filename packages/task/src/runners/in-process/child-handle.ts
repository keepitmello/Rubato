export type ChildSessionEvent = {
  readonly type: string
  readonly message?: unknown
}

export type ChildSessionListener = (event: ChildSessionEvent) => void

// The engine announces a session's end to its extensions (session_shutdown) before dispose();
// extensions release per-session state there. A child session is disposed directly, so the handle
// makes the same announcement itself.
export type ChildSessionShutdownEvent = { readonly type: "session_shutdown"; readonly reason: "quit" }
// Work that will still wake the session: `active` (running work whose completion arrives as a turn)
// and `undelivered` (a completion produced but not yet handed to the session). The engine sums every
// extension's `*.pending-work` answer (extension-rpc); print mode holds a one-shot run on the same count.
export type ChildPendingWork = { readonly active: number; readonly undelivered: number }
export type ChildExtensionRunner = {
  hasHandlers(event: string): boolean
  emit(event: ChildSessionShutdownEvent): Promise<unknown>
  pendingWork?(): Promise<ChildPendingWork>
}

// Structural subset of senpi's AgentSession that the handle drives. The default seam returns a
// live AgentSession; fakes implement only these members.
export type ChildSession = {
  readonly sessionId: string
  readonly extensionRunner?: ChildExtensionRunner
  // No active agent run. A wake (a monitor event, a background exit) starts a run on an idle session.
  readonly isIdle?: boolean
  prompt(text: string): Promise<void>
  // Stock pi 1.0 resolves these with a "handled" | "queued" disposition; the runner does not need it.
  steer(text: string): Promise<unknown>
  followUp(text: string): Promise<unknown>
  abort(): Promise<void>
  subscribe(listener: ChildSessionListener): () => void
  getLastAssistantText(): string | undefined
  waitForIdle?(): Promise<void>
  dispose(): void
}

export type RunnerFailure = {
  // The snake_case kinds map 1:1 onto the manager's respawn disposition codes (todo 12): a resume
  // rebuild failure is TYPED and retryable, never a silently weakened tool set or transcript.
  readonly kind:
    | "child-prompt-failed"
    | "child-turn-failed"
    | "session-create-failed"
    | "depth-exceeded"
    | "model_unavailable"
    | "tools_unavailable"
    | "session_unavailable"
  readonly message: string
  readonly cause?: unknown
}

export type RunnerOutcome =
  | { readonly status: "completed"; readonly finalResponse: string }
  | { readonly status: "error"; readonly failure: RunnerFailure; readonly killed?: boolean }
  | { readonly status: "cancelled" }

export type ChildHandle = {
  readonly task_id: string
  readonly sessionId: string
  steer(text: string): Promise<void>
  followUp(text: string): Promise<void>
  abort(): Promise<void>
  subscribe(listener: ChildSessionListener): () => void
  waitForIdle(): Promise<RunnerOutcome>
  lastAssistantText(): string | undefined
  dispose(): Promise<void>
}

export type CreateChildHandleInput = {
  readonly taskId: string
  readonly session: ChildSession
  readonly promptText: string
  readonly hold?: PendingWorkHoldOptions
}

export type CreateRestoredChildHandleInput = {
  readonly taskId: string
  readonly session: ChildSession
  readonly hold?: PendingWorkHoldOptions
}

// Timings of the pending-work hold, the same as print mode's holdForPendingWork (extension-rpc
// runtime.mjs). Once the run has held, "nothing pending" must last `settleMs`: a background exit
// hands its notification to the session asynchronously, with no count in between. A completion that
// sits undelivered while the session idles past `stuckDeliveryMs` stops holding the run.
export type PendingWorkHoldOptions = {
  readonly pollMs?: number
  readonly settleMs?: number
  readonly stuckDeliveryMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

// Per-turn facts observed from the session's event stream. senpi surfaces provider/stream failures
// as an assistant message with stopReason "error"/"aborted" + errorMessage while prompt() resolves
// cleanly, so the turn outcome must be derived from what the turn actually EMITTED, never assumed
// from prompt() resolution alone (the silent-empty-completion bug).
type TurnObservation = {
  text: string | undefined
  stopReason: string | undefined
  errorMessage: string | undefined
  baseline: string | undefined
  // Text of every assistant message that ended a turn in this run. A held run spans several turns
  // ("still waiting on the build" ... the report ... "that notice was the same run"), and the
  // dispatcher must get the report even when a late wake adds a turn after it.
  turnEnds: string[]
}

function observeTurnEvent(observation: TurnObservation, event: ChildSessionEvent): void {
  if (event.type !== "message_end") return
  const message = event.message
  if (!isRecord(message) || message.role !== "assistant") return
  const text = assistantText(message)
  if (text !== undefined) observation.text = text
  observation.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined
  observation.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined
  if (text !== undefined && observation.stopReason !== "toolUse") observation.turnEnds.push(text)
}

function assistantText(message: Record<string, unknown>): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const text = message.content
    .filter((part: unknown): part is { readonly type: "text"; readonly text: string } => isTextPart(part))
    .map((part) => part.text)
    .join("")
  return text.length > 0 ? text : undefined
}

function isTextPart(part: unknown): part is { readonly type: "text"; readonly text: string } {
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Derive the settled turn's outcome from what it emitted. The session-level getLastAssistantText()
// is only trusted when it CHANGED during this turn (baseline diff): on a revive, the previous run's
// text must never masquerade as a fresh completion.
function turnOutcome(session: ChildSession, observation: TurnObservation): RunnerOutcome {
  if (observation.stopReason === "error" || observation.stopReason === "aborted") {
    return {
      status: "error",
      failure: {
        kind: "child-turn-failed",
        message: observation.errorMessage ?? `child turn ended with stopReason "${observation.stopReason}"`,
      },
    }
  }
  if (observation.turnEnds.length > 1) return { status: "completed", finalResponse: observation.turnEnds.join("\n\n") }
  if (observation.text !== undefined) return { status: "completed", finalResponse: observation.text }
  const final = session.getLastAssistantText()
  if (final !== undefined && final.length > 0 && final !== observation.baseline) {
    return { status: "completed", finalResponse: final }
  }
  return {
    status: "error",
    failure: {
      kind: "child-turn-failed",
      message: observation.errorMessage ?? "child turn produced no assistant output",
    },
  }
}

// A turn that ends while its own background work is still running has not finished the task: the
// child said "the result will arrive" and ended its turn, as the bash/monitor tools tell it to, and
// the completion wakes it with a new turn in this session. Settling at the first turn end woke the
// dispatcher with "still waiting on X" as the final response. The run therefore settles only when
// the session is idle with no pending work, like print mode's one-shot hold.
async function holdForPendingWork(
  session: ChildSession,
  isAborted: () => boolean,
  heldPrompts: () => Promise<void> | undefined,
  options: PendingWorkHoldOptions,
): Promise<void> {
  const runner = session.extensionRunner
  if (typeof runner?.pendingWork !== "function" || typeof session.waitForIdle !== "function") return
  const pollMs = options.pollMs ?? 250
  const settleMs = options.settleMs ?? 3_000
  const stuckDeliveryMs = options.stuckDeliveryMs ?? 90_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let stuckSince: number | undefined
  let held = false
  let settled = false
  for (;;) {
    await session.waitForIdle()
    const prompts = heldPrompts()
    if (prompts !== undefined) {
      await prompts
      held = true
      settled = false
      continue
    }
    if (isAborted()) return
    let pending: ChildPendingWork
    try {
      pending = await runner.pendingWork()
    } catch {
      return
    }
    if (session.isIdle === false || heldPrompts() !== undefined) {
      stuckSince = undefined
      held = true
      settled = false
      continue
    }
    if (pending.active === 0 && pending.undelivered === 0) {
      if (!held || settled) return
      settled = true
      await sleep(settleMs)
      continue
    }
    held = true
    settled = false
    if (pending.active === 0) {
      stuckSince ??= now()
      if (now() - stuckSince >= stuckDeliveryMs) return
    } else {
      stuckSince = undefined
    }
    await sleep(pollMs)
  }
}

// A prompt turn is a TRACKED async op: the promise is created and its rejection handled at the
// call site, so steering can happen WHILE it runs and no rejection ever escapes. The same routine
// drives the initial prompt and every revive follow-up (a fresh turn on an idle resident session).
async function runTurn(
  session: ChildSession,
  text: string,
  isAborted: () => boolean,
  observation: TurnObservation,
  hold: () => Promise<void>,
): Promise<RunnerOutcome> {
  try {
    await session.prompt(text)
  } catch (error) {
    if (isAborted()) return { status: "cancelled" }
    if (error instanceof Error) {
      return {
        status: "error",
        failure: { kind: "child-prompt-failed", message: error.message, cause: error },
      }
    }
    const message = String(error)
    return {
      status: "error",
      failure: { kind: "child-prompt-failed", message, cause: error },
    }
  }
  if (isAborted()) return { status: "cancelled" }
  await hold()
  if (isAborted()) return { status: "cancelled" }
  return turnOutcome(session, observation)
}

// The outcome a restored handle owes waitForIdle() before any follow-up starts a turn: the
// transcript's last assistant text is the honest drain for a child whose completion never reached
// its record (crash between turn end and transition). No text means nothing durable was produced.
function settledSessionOutcome(session: ChildSession): RunnerOutcome {
  const final = session.getLastAssistantText()
  if (final !== undefined && final.length > 0) return { status: "completed", finalResponse: final }
  return {
    status: "error",
    failure: { kind: "child-turn-failed", message: "restored session has no assistant output" },
  }
}

// A child disposed without session_shutdown left its extensions' per-session registrations behind:
// context-notes keeps a process-wide gate per session id, so the next child resumed under the same
// id found the old gate, whose ctx the dispose had invalidated, and every revive after the parent
// was unloaded failed with "This extension ctx is stale". A failing handler must neither keep the
// session alive nor stop the caller's teardown of other children.
async function shutdownChildSession(session: ChildSession): Promise<void> {
  try {
    const runner = session.extensionRunner
    if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" })
  } catch {
    // The engine reports extension handler failures itself; the dispose below is what matters here.
  }
  session.dispose()
}

type TrackedChildHandle = {
  readonly handle: ChildHandle
  beginTurn(text: string): void
}

function createTrackedChildHandle(
  taskId: string,
  session: ChildSession,
  holdOptions: PendingWorkHoldOptions = {},
): TrackedChildHandle {
  let aborted = false
  let disposed = false
  let turnActive = false
  // True from the first turn end until the run settles: the session may be idle between turns.
  let holding = false
  const heldPrompts = new Set<Promise<void>>()
  // Seeded for the restored case; createChildHandle's beginTurn replaces it immediately.
  let running: Promise<RunnerOutcome> = Promise.resolve(settledSessionOutcome(session))
  const observation: TurnObservation = {
    text: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    baseline: undefined,
    turnEnds: [],
  }
  const unsubscribeObserver = session.subscribe((event) => observeTurnEvent(observation, event))

  const hold = async (): Promise<void> => {
    holding = true
    try {
      await holdForPendingWork(
        session,
        () => aborted,
        () => (heldPrompts.size === 0 ? undefined : Promise.all(heldPrompts).then(() => undefined)),
        holdOptions,
      )
    } finally {
      holding = false
    }
  }

  // A message queued on an idle session waits for a run that never starts, so a message that
  // arrives while the run is held between turns opens the next turn itself. If the session cannot
  // take a prompt right now, the message stays queued for the next wake.
  const deliverWhileHeld = (text: string): void => {
    const delivery: Promise<void> = session.prompt(text).catch(() => session.followUp(text)).then(() => undefined, () => undefined)
    heldPrompts.add(delivery)
    void delivery.then(() => heldPrompts.delete(delivery))
  }
  const heldIdle = (): boolean => holding && session.isIdle === true

  // Start a fresh tracked turn and mark it active until it settles. waitForIdle() always returns the
  // CURRENT turn, so a revive follow-up re-arms it to the new turn instead of a stale resolved one.
  const beginTurn = (text: string): void => {
    aborted = false
    turnActive = true
    observation.text = undefined
    observation.stopReason = undefined
    observation.errorMessage = undefined
    observation.baseline = session.getLastAssistantText()
    observation.turnEnds = []
    running = runTurn(session, text, () => aborted, observation, hold)
    void running.then(
      () => {
        turnActive = false
      },
      () => {
        turnActive = false
      },
    )
  }

  const handle: ChildHandle = {
    task_id: taskId,
    sessionId: session.sessionId,
    steer: async (text) => {
      if (heldIdle()) {
        deliverWhileHeld(text)
        return
      }
      await session.steer(text)
    },
    followUp: async (text) => {
      // While a turn is running, a follow-up is queued and delivered when the agent settles. Once
      // the child is idle/resident, a follow-up REVIVES it: drive a fresh turn and re-arm tracking.
      if (turnActive) {
        if (heldIdle()) {
          deliverWhileHeld(text)
          return
        }
        await session.followUp(text)
        return
      }
      beginTurn(text)
    },
    abort: async () => {
      aborted = true
      await session.abort()
    },
    subscribe: (listener) => session.subscribe(listener),
    waitForIdle: () => running,
    lastAssistantText: () => session.getLastAssistantText(),
    dispose: async () => {
      if (disposed) return
      disposed = true
      unsubscribeObserver()
      await shutdownChildSession(session)
    },
  }
  return { handle, beginTurn }
}

export function createChildHandle(input: CreateChildHandleInput): ChildHandle {
  const tracked = createTrackedChildHandle(input.taskId, input.session, input.hold)
  tracked.beginTurn(input.promptText)
  return tracked.handle
}

// A restored child is rebuilt from its persisted transcript: the original prompt is NEVER
// replayed. The handle restores IDLE - its first followUp() starts a fresh tracked turn exactly
// like a resident revival (any continuation nudge is manager-owned, todo 12, never the runner's).
export function createRestoredChildHandle(input: CreateRestoredChildHandleInput): ChildHandle {
  return createTrackedChildHandle(input.taskId, input.session, input.hold).handle
}
