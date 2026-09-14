import type { ActionRequestEnvelope, ActionResultResponse, LiveSessionId, RequestId } from "@rubato/remote-protocol"

export interface SurfaceActions {
  dispatch(request: ActionRequestEnvelope): Promise<ActionResultResponse>
}

interface CachedResult {
  readonly expiresAt: number
  readonly result: ActionResultResponse
}

export class SessionActionQueue {
  readonly #surface: SurfaceActions
  readonly #revision: (id: LiveSessionId) => number
  readonly #now: () => number
  readonly #chains = new Map<LiveSessionId, Promise<void>>()
  readonly #cache = new Map<RequestId, CachedResult>()
  readonly #inflight = new Map<RequestId, Promise<ActionResultResponse>>()

  constructor(surface: SurfaceActions, revision: (id: LiveSessionId) => number, now: () => number = Date.now) {
    this.#surface = surface
    this.#revision = revision
    this.#now = now
  }

  enqueue(request: ActionRequestEnvelope): Promise<ActionResultResponse> {
    this.#purge()
    const cached = this.#cache.get(request.requestId)
    if (cached) return Promise.resolve(cached.result)
    const inflight = this.#inflight.get(request.requestId)
    if (inflight) return inflight
    const currentRevision = this.#revision(request.liveSessionId)
    if (request.expectedRevision !== undefined && request.expectedRevision !== currentRevision) {
      return Promise.reject(new ActionQueueError("stale_revision"))
    }
    // Replies and interrupts must reach a surface that is waiting inside an
    // earlier action. Ordinary mutations remain FIFO per live session.
    const interrupt = ["agent.abort", "bash.abort", "ui.respond"].includes(request.action)
    const previous = interrupt ? Promise.resolve() : this.#chains.get(request.liveSessionId) ?? Promise.resolve()
    const resultPromise = previous.then(async () => {
      if (request.expectedRevision !== undefined && request.expectedRevision !== this.#revision(request.liveSessionId)) {
        throw new ActionQueueError("stale_revision")
      }
      const result = await this.#surface.dispatch(request)
      this.#cache.set(request.requestId, { result, expiresAt: this.#now() + 10 * 60 * 1000 })
      return result
    })
    this.#inflight.set(request.requestId, resultPromise)
    const cleanup = () => {
      this.#inflight.delete(request.requestId)
      if (this.#chains.get(request.liveSessionId) === operation) this.#chains.delete(request.liveSessionId)
    }
    const operation = resultPromise.then(cleanup, cleanup)
    if (!interrupt) this.#chains.set(request.liveSessionId, operation)
    return resultPromise
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, value] of this.#cache) if (value.expiresAt <= now) this.#cache.delete(key)
  }
}

export class ActionQueueError extends Error {
  readonly code: "stale_revision" | "busy"

  constructor(code: "stale_revision" | "busy") {
    super(code)
    this.name = "ActionQueueError"
    this.code = code
  }
}
