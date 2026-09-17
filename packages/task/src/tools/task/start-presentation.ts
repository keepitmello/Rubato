import type { StartResult } from "../../manager"

type StartedResult = Extract<StartResult, { kind: "started" }>

export type StartLabels = {
  readonly taskSummary?: string
}

export function backgroundStartText(started: StartedResult, labels: StartLabels): string {
  const queue = started.queue_position !== undefined ? ` queued at position ${started.queue_position}` : ""
  const label = labels.taskSummary ?? started.name
  if (label === started.task_id) {
    return `Started agent ${started.task_id} (${started.status})${queue}. Completion status is automatically delivered; the child's body is not inlined. End your turn if no independent work remains; otherwise keep working. Use AgentSend only to steer it.`
  }
  return `Started agent ${label} (${started.task_id}, ${started.status})${queue}. Completion status is automatically delivered; the child's body is not inlined. End your turn if no independent work remains; otherwise keep working. Use AgentSend only to steer it.`
}
