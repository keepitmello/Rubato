import { Type } from "typebox"
import type { Static } from "typebox"

export const TaskSendParams = Type.Object({
  agentId: Type.String({ description: "Child agentId to send the follow-up to." }),
  message: Type.String({ description: "The follow-up instruction." }),
})

export const MemberScopedTaskSendParams = TaskSendParams

export type TaskSendInput = Static<typeof TaskSendParams>
export type MemberScopedTaskSendInput = TaskSendInput
