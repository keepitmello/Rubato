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

  constructor(surface: SurfaceActions, revision: (id: LiveSessionId) => number, now: () => number = Date.now) {
    this.#surface = surface
    this.#revision = revision
    this.#now = now
  }

  enqueue(request: ActionRequestEnvelope): Promise<ActionResultResponse> {
    this.#purge()
    const cached = this.#cache.get(request.requestId)
    if (cached) return Promise.resolve(cached.result)
    const currentRevision = this.#revision(request.liveSessionId)
    if (request.expectedRevision !== undefined && request.expectedRevision !== currentRevision) {
      return Promise.reject(new ActionQueueError("stale_revision"))
    }
    let resolveResult!: (result: ActionResultResponse) => void
    let rejectResult!: (error: unknown) => void
    const resultPromise = new Promise<ActionResultResponse>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const previous = this.#chains.get(request.liveSessionId) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const existing = this.#cache.get(request.requestId)
      if (existing) {
        resolveResult(existing.result)
        return
      }
      try {
        const result = await this.#surface.dispatch(request)
        this.#cache.set(request.requestId, { result, expiresAt: this.#now() + 10 * 60 * 1000 })
        resolveResult(result)
      } catch (error) {
        rejectResult(error)
      }
    })
    this.#chains.set(request.liveSessionId, operation)
    void operation.finally(() => {
      if (this.#chains.get(request.liveSessionId) === operation) this.#chains.delete(request.liveSessionId)
    })
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
