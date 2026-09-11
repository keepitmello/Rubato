#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { BoardError, openBoard, TASK_STATUSES } from "./board.js"

const server = new McpServer({ name: "taskforce", version: "0.1.0" })
const board = openBoard()
const statusSchema = z.enum(TASK_STATUSES)
const scopeSchema = {
  workspace: z.string().min(1).describe("Explicit stable absolute workspace identity shared across worktrees."),
  run_id: z.string().min(1).describe("Native Codex root/thread id or another explicit run identity."),
}

function response(fn) {
  try {
    const result = fn()
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: { result },
    }
  } catch (error) {
    const detail = error instanceof BoardError
      ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      : { code: "internal", message: error instanceof Error ? error.message : String(error) }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
      structuredContent: { error: detail },
    }
  }
}

server.registerTool("task_create", {
  description: "Create a pending work-board item. This records workflow only and never starts a Codex agent.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    ...scopeSchema,
    subject: z.string().min(1),
    description: z.string().min(1),
    blocked_by: z.array(z.union([z.string(), z.number().int().positive()])).optional(),
    outcome: z.string().min(1).optional(),
    write_ownership: z.string().min(1).optional(),
    budget: z.string().min(1).optional(),
    done_evidence: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
}, (input) => response(() => board.create(input)))

server.registerTool("task_list", {
  description: "List work-board items in the explicit workspace and run scope supplied with this call.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: { ...scopeSchema, status: statusSchema.optional(), owner: z.string().min(1).optional() },
}, (input) => response(() => board.list(input)))

server.registerTool("task_get", {
  description: "Get one board item and its audit events. A board task id is not a Codex agent id.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: { ...scopeSchema, task_id: z.union([z.string(), z.number().int().positive()]) },
}, (input) => response(() => board.get(input)))

server.registerTool("task_update", {
  description: "Claim or advance a board item, complete it with evidence, delete it, or explicitly recover it from an unavailable owner. Actor identity is caller-supplied cooperative metadata, not authentication. This never changes native Codex lifecycle.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    ...scopeSchema,
    task_id: z.union([z.string(), z.number().int().positive()]),
    actor: z.string().min(1).describe("Native Codex agent id or canonical task name; not authenticated."),
    status: statusSchema.optional(),
    evidence: z.string().min(1).optional(),
    reassign_to: z.string().min(1).optional(),
    recovery_reason: z.string().min(1).optional(),
  },
}, (input) => response(() => board.update(input)))

const transport = new StdioServerTransport()
await server.connect(transport)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    board.close()
    await server.close()
    process.exit(0)
  })
}
