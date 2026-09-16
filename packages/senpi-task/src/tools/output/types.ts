import type { AgentToolResult } from "@code-yeongyu/senpi"
import type { AgentSnapshot } from "@rubato/agent-core"

import type { TaskManager } from "../../manager"
import type { CallerSessionResolver } from "../control"

export type OutputManager = Pick<TaskManager, "get">

export type TranscriptEntry =
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: string; readonly is_error: boolean }
  | { readonly kind: "error"; readonly message: string }

export type TranscriptSource = "event-log" | "session-jsonl" | "none"

export type TranscriptReadResult = {
  readonly entries: readonly TranscriptEntry[]
  readonly source: TranscriptSource
  readonly truncated?: boolean
}

export type TranscriptReader = (input: { readonly taskId: string; readonly stateDir: string }) => TranscriptReadResult

export type TaskOutputDetails =
  | { readonly kind: "status"; readonly snapshot: AgentSnapshot }
  | {
      readonly kind: "transcript"
      readonly mode: "tail" | "full"
      readonly source: TranscriptSource
      readonly transcript: string
      readonly truncated: boolean
      readonly snapshot: AgentSnapshot
    }
  | { readonly kind: "not_found"; readonly reason: string; readonly known_agents: readonly string[] }
  | { readonly kind: "invalid_arguments"; readonly reason: string }

export type TaskOutputDeps = {
  readonly manager: OutputManager
  readonly stateDir: string
  readonly transcriptReader?: TranscriptReader
  readonly resolveCallerSessionId?: CallerSessionResolver
  readonly now?: () => number
  readonly ownsActiveTeam?: (sessionId: string) => boolean | Promise<boolean>
}

export type TaskOutputToolResult = AgentToolResult<TaskOutputDetails>
