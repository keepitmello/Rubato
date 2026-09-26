#!/usr/bin/env node
// Standalone stdio MCP server exposing the Rubato memory tools. The senpi extension registers this server
// with exposure "search" so the tools surface through the tool_search catalog instead of occupying
// the always-on tool set. It runs under plain Node with no engine runtime: the extension's tool_call
// bridge injects the session's bound store. A call without it comes from a folder that names no store.

import { dirname, resolve } from "node:path"
import type { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"

import {
  errorResponse,
  isPlainRecord,
  jsonRpcId,
  runJsonRpcStdioServer,
  successResponse,
  type JsonRpcResponse,
} from "@rubato/mcp-stdio-core"
import {
  MemoryApplyPatchError,
  MemoryPatchHunkError,
  MemoryPatchParseError,
  MemoryToolError,
  buildIdentityPaths,
  runMemoryApplyPatch,
  runMemoryTool,
  type MemoryToolParams,
} from "@rubato/memory-core"

import { prepareMemoryEngineSession } from "../components/memory/engine-session"
import {
  MEMORY_APPLY_PATCH_DESCRIPTION,
  MEMORY_APPLY_PATCH_TOOL_NAME,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  MEMORY_UNBOUND_MESSAGE,
} from "../components/memory/tool-metadata"

const SERVER_NAME = "rubato-memory"
const SERVER_VERSION = "0.1.0"

const MEMORY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["create", "str_replace", "insert", "delete", "rename", "update_description"],
      description: "The memory operation to perform.",
    },
    reason: { type: "string", description: "Git commit message recorded for this memory change." },
    file_path: { type: "string", description: "Target memory file: relative to the memory repo, or absolute inside it. Required by create, str_replace, insert, delete, and update_description." },
    old_path: { type: "string", description: "Current path of the memory file. Required by rename." },
    new_path: { type: "string", description: "Destination path of the memory file. Required by rename." },
    old_string: { type: "string", description: "Exact text to replace. Required by str_replace." },
    new_string: { type: "string", description: "Replacement text. Required by str_replace." },
    insert_line: { type: "number", description: "1-based line number at which to insert text. Required by insert." },
    insert_text: { type: "string", description: "Text to insert. Required by insert." },
    description: { type: "string", description: "Frontmatter description of the memory block. Required by create and update_description." },
    file_text: { type: "string", description: "Initial body text for create." },
  },
  required: ["command", "reason"],
  additionalProperties: false,
} as const

const APPLY_PATCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", description: "Git commit message recorded for this memory change." },
    input: { type: "string", description: "Patch text in the standard apply_patch format (*** Begin Patch ... *** End Patch)." },
  },
  required: ["reason", "input"],
  additionalProperties: false,
} as const

const TOOLS = [
  { name: MEMORY_TOOL_NAME, description: MEMORY_TOOL_DESCRIPTION, inputSchema: MEMORY_INPUT_SCHEMA },
  { name: MEMORY_APPLY_PATCH_TOOL_NAME, description: MEMORY_APPLY_PATCH_DESCRIPTION, inputSchema: APPLY_PATCH_INPUT_SCHEMA },
]

export async function handleMemoryMcpRequest(
  input: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (!isPlainRecord(input)) return errorResponse(null, -32600, "Invalid Request")
  const id = jsonRpcId(input["id"])
  const method = typeof input["method"] === "string" ? input["method"] : null

  if (method === "initialize") {
    return successResponse(id, {
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      protocolVersion: readProtocolVersion(input) ?? "2024-11-05",
    })
  }
  if (method === "tools/list") return successResponse(id, { tools: TOOLS })
  if (method === "notifications/initialized") return undefined

  if (method === "tools/call") {
    const params = isPlainRecord(input["params"]) ? input["params"] : {}
    const name = typeof params["name"] === "string" ? params["name"] : ""
    const args = isPlainRecord(params["arguments"]) ? params["arguments"] : {}
    return callMemoryTool(id, name, args)
  }

  return errorResponse(id, -32601, "Method not found")
}

async function callMemoryTool(
  id: string | number | null,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  if (name !== MEMORY_TOOL_NAME && name !== MEMORY_APPLY_PATCH_TOOL_NAME) {
    return toolText(id, `Unknown ${SERVER_NAME} tool: ${name}`, true)
  }
  try {
    const provenance = readMcpProvenance(args)
    if (provenance === undefined) return toolText(id, `${name}: ${MEMORY_UNBOUND_MESSAGE}`, true)
    const identity = {
      id: provenance.identityId,
      paths: buildIdentityPaths(dirname(dirname(dirname(provenance.repoPath))), provenance.identityId),
    }
    const session = await prepareMemoryEngineSession(identity.id, identity.paths, {
      origin: { ...(provenance.root === undefined ? {} : { root: provenance.root }), home: provenance.home },
    })
    const toolProvenance = { sessionId: provenance.sessionId }
    if (name === MEMORY_TOOL_NAME) {
      // Field-level validation lives in runMemoryTool's required() guards, so the MCP argument record
      // is asserted straight into the core param shape rather than re-validated here.
      const params = {
        ...args,
        author: session.author,
        provenance: toolProvenance,
      } as MemoryToolParams
      const result = await runMemoryTool({ repo: session.repo, lock: session.lock, params })
      return toolText(id, result.message)
    }
    const result = await runMemoryApplyPatch({
      repo: session.repo,
      lock: session.lock,
      params: {
        reason: typeof args.reason === "string" ? args.reason : "",
        input: typeof args.input === "string" ? args.input : "",
        author: session.author,
        provenance: toolProvenance,
      },
    })
    return toolText(id, result.message)
  } catch (error) {
    if (
      error instanceof MemoryToolError
      || error instanceof MemoryApplyPatchError
      || error instanceof MemoryPatchParseError
      || error instanceof MemoryPatchHunkError
    ) {
      return toolText(id, error.message, true)
    }
    throw error
  }
}

interface McpMemoryProvenance {
  readonly sessionId: string
  readonly identityId: string
  readonly repoPath: string
  /** Project root the session bound from; recorded in store.json on write. */
  readonly root?: string
  readonly home: boolean
}

function readMcpProvenance(args: Record<string, unknown>): McpMemoryProvenance | undefined {
  const value = args.provenance
  if (!isPlainRecord(value)) return undefined
  if (
    typeof value.sessionId !== "string"
    || value.sessionId.length === 0
    || typeof value.identityId !== "string"
    || value.identityId.length === 0
    || typeof value.repoPath !== "string"
    || value.repoPath.length === 0
  ) return undefined
  return {
    sessionId: value.sessionId,
    identityId: value.identityId,
    repoPath: resolve(value.repoPath),
    ...(typeof value.root === "string" && value.root.length > 0 ? { root: resolve(value.root) } : {}),
    home: value.home === true,
  }
}

function toolText(id: string | number | null, text: string, isError = false): JsonRpcResponse {
  return successResponse(id, { content: [{ type: "text", text }], isError })
}

function readProtocolVersion(input: Record<string, unknown>): string | null {
  const params = input["params"]
  if (!isPlainRecord(params)) return null
  const version = params["protocolVersion"]
  return typeof version === "string" ? version : null
}

export async function runMemoryMcpStdioServer(input: Readable, output: Writable): Promise<void> {
  await runJsonRpcStdioServer({
    input,
    output,
    handler: handleMemoryMcpRequest,
    handlerOptions: undefined,
    parentWatchdog: {},
    parseErrorResponse: () => errorResponse(null, -32601, "Method not found"),
  })
}

const invokedPath = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath !== "" && import.meta.url === invokedPath) {
  await runMemoryMcpStdioServer(process.stdin, process.stdout)
}
