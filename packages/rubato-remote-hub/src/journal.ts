import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  REMOTE_PROTOCOL_NAME,
  eventEnvelopeSchema,
  sessionSnapshotSchema,
  type EventEnvelope,
  type HostId,
  type JsonObject,
  type LiveSessionId,
  type LiveSessionSummary,
  type RemoteEventType,
  type SessionSnapshot,
  type SessionSnapshotState,
  type SnapshotRequiredFrame,
} from "@rubato/remote-protocol"
import { appendPrivateLine, ensurePrivateDirectory, readJson, writePrivateFile } from "./files.js"

export type ReplayResult =
  | { readonly type: "events"; readonly events: readonly EventEnvelope[] }
  | SnapshotRequiredFrame

export interface JournalOptions {
  readonly maxEvents?: number
  readonly maxAgeMs?: number
  readonly now?: () => number
}

export class EventJournal {
  readonly #root: string
  readonly #snapshotsRoot: string
  readonly #hostId: HostId
  readonly #maxEvents: number
  readonly #maxAgeMs: number
  readonly #now: () => number
  readonly #events = new Map<LiveSessionId, EventEnvelope[]>()
  readonly #highWater = new Map<LiveSessionId, number>()
  readonly #snapshots = new Map<LiveSessionId, SessionSnapshot>()
  readonly #chains = new Map<LiveSessionId, Promise<void>>()

  constructor(root: string, snapshotsRoot: string, hostId: HostId, options: JournalOptions = {}) {
    this.#root = root
    this.#snapshotsRoot = snapshotsRoot
    this.#hostId = hostId
    this.#maxEvents = options.maxEvents ?? 10_000
    this.#maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000
    this.#now = options.now ?? Date.now
  }

  async load(liveSessionIds?: readonly LiveSessionId[]): Promise<void> {
    await ensurePrivateDirectory(this.#root)
    await ensurePrivateDirectory(this.#snapshotsRoot)
    const ids = liveSessionIds ?? await this.#storedSessionIds()
    await Promise.all(ids.map(async (id) => {
      const events = await readJournalFile(this.#journalPath(id))
      this.#events.set(id, retain(events, this.#now(), this.#maxEvents, this.#maxAgeMs))
      const storedSnapshot = await readJson<unknown>(this.#snapshotPath(id), null)
      const parsedSnapshot = sessionSnapshotSchema.safeParse(storedSnapshot)
      const snapshot = parsedSnapshot.ok ? parsedSnapshot.value : undefined
      if (snapshot) this.#snapshots.set(id, snapshot)
      this.#highWater.set(id, Math.max(events.at(-1)?.seq ?? 0, snapshot?.lastSeq ?? 0))
    }))
  }

  lastSeq(id: LiveSessionId): number {
    return Math.max(this.#highWater.get(id) ?? 0, this.#snapshots.get(id)?.lastSeq ?? 0)
  }

  append(id: LiveSessionId, type: RemoteEventType, payload: JsonObject, flush = false): Promise<EventEnvelope> {
    let resolveEvent!: (event: EventEnvelope) => void
    let rejectEvent!: (error: unknown) => void
    const result = new Promise<EventEnvelope>((resolve, reject) => {
      resolveEvent = resolve
      rejectEvent = reject
    })
    const previous = this.#chains.get(id) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const event: EventEnvelope = {
        protocol: REMOTE_PROTOCOL_NAME,
        hostId: this.#hostId,
        liveSessionId: id,
        seq: this.lastSeq(id) + 1,
        at: new Date(this.#now()).toISOString(),
        type,
        payload,
      }
      const current = this.#events.get(id) ?? []
      const retained = retain([...current, event], this.#now(), this.#maxEvents, this.#maxAgeMs)
      this.#events.set(id, retained)
      this.#highWater.set(id, event.seq)
      if (retained.length !== current.length + 1) {
        await writePrivateFile(this.#journalPath(id), `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
      } else {
        await appendPrivateLine(this.#journalPath(id), JSON.stringify(event), flush)
      }
      resolveEvent(event)
    }).catch((error: unknown) => rejectEvent(error))
    this.#chains.set(id, operation)
    void operation.finally(() => {
      if (this.#chains.get(id) === operation) this.#chains.delete(id)
    })
    return result
  }

  replay(id: LiveSessionId, afterSeq: number): ReplayResult {
    const events = this.#events.get(id) ?? []
    const lastSeq = this.lastSeq(id)
    if (afterSeq >= lastSeq) return { type: "events", events: [] }
    const first = events[0]
    if (!first || afterSeq < first.seq - 1) {
      const snapshot = this.#snapshots.get(id)
      return snapshot
        ? { type: "snapshot.required", protocol: REMOTE_PROTOCOL_NAME, liveSessionId: id, snapshot }
        : { type: "snapshot.required", protocol: REMOTE_PROTOCOL_NAME, liveSessionId: id }
    }
    return { type: "events", events: events.filter((event) => event.seq > afterSeq) }
  }

  async snapshot(summary: LiveSessionSummary, state: SessionSnapshotState): Promise<SessionSnapshot> {
    const snapshot: SessionSnapshot = {
      schemaVersion: 1,
      liveSessionId: summary.liveSessionId,
      lastSeq: this.lastSeq(summary.liveSessionId),
      writtenAt: new Date(this.#now()).toISOString(),
      summary,
      state,
    }
    await writePrivateFile(this.#snapshotPath(summary.liveSessionId), JSON.stringify(snapshot))
    this.#snapshots.set(summary.liveSessionId, snapshot)
    return snapshot
  }

  getSnapshot(id: LiveSessionId): SessionSnapshot | undefined {
    return this.#snapshots.get(id)
  }

  summaries(): readonly LiveSessionSummary[] {
    return [...this.#snapshots.values()].map(({ summary }) => summary)
  }

  async drain(): Promise<void> {
    await Promise.all(this.#chains.values())
  }

  async #storedSessionIds(): Promise<readonly LiveSessionId[]> {
    const names = [...await readdir(this.#root), ...await readdir(this.#snapshotsRoot)]
    return [...new Set(names.map((name) => name.replace(/\.(?:jsonl|json)$/, "")).filter((name) => /^[0-9a-f-]{36}$/i.test(name)))] as LiveSessionId[]
  }

  #journalPath(id: LiveSessionId): string {
    return join(this.#root, `${id}.jsonl`)
  }

  #snapshotPath(id: LiveSessionId): string {
    return join(this.#snapshotsRoot, `${id}.json`)
  }
}

async function readJournalFile(path: string): Promise<EventEnvelope[]> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const events: EventEnvelope[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      continue
    }
    const result = eventEnvelopeSchema.safeParse(parsed)
    if (result.ok) events.push(result.value)
  }
  events.sort((a, b) => a.seq - b.seq)
  return events.filter((event, index) => index === 0 || event.seq > events[index - 1]!.seq)
}

function retain(events: readonly EventEnvelope[], now: number, maxEvents: number, maxAgeMs: number): EventEnvelope[] {
  const cutoff = now - maxAgeMs
  return events.filter((event) => Date.parse(event.at) >= cutoff).slice(-maxEvents)
}
