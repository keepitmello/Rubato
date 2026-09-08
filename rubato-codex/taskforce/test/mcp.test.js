import assert from "node:assert/strict"
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const NODE = process.execPath
const SERVER = path.resolve("src/mcp-server.js")
const BUNDLE = path.resolve("dist/mcp-server.mjs")

test("real SDK client initializes, discovers, and calls the stdio MCP", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "taskforce-mcp-test-"))
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SERVER],
    cwd: path.resolve("."),
    env: { ...process.env, TASKFORCE_STATE_DIR: stateDir },
    stderr: "pipe",
  })
  const client = new Client({ name: "taskforce-test-client", version: "0.1.0" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["task_create", "task_get", "task_list", "task_update"])
    for (const tool of tools.tools) {
      assert.deepEqual(tool.inputSchema.required.slice(0, 2), ["workspace", "run_id"])
    }
    const annotations = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.annotations]))
    assert.deepEqual(annotations, {
      task_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      task_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      task_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      task_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    })

    const scope = { workspace: "/mcp/workspace", run_id: "native-root-id" }
    const created = await client.callTool({
      name: "task_create",
      arguments: { ...scope, subject: "MCP task", description: "called over stdio" },
    })
    assert.equal(created.isError, undefined)
    assert.equal(created.structuredContent.result.id, "1")

    const listed = await client.callTool({ name: "task_list", arguments: scope })
    assert.equal(listed.structuredContent.result.length, 1)
    assert.equal(listed.structuredContent.result[0].subject, "MCP task")
  } finally {
    await client.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("standalone bundle serves MCP from an isolated directory without node_modules", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "taskforce-bundle-test-"))
  const serverPath = path.join(fixture, "mcp-server.mjs")
  const stateDir = path.join(fixture, "state")
  await copyFile(BUNDLE, serverPath)
  assert.deepEqual(await readdir(fixture), ["mcp-server.mjs"])

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: fixture,
    env: { TASKFORCE_STATE_DIR: stateDir, PATH: process.env.PATH },
    stderr: "pipe",
  })
  const client = new Client({ name: "taskforce-bundle-test", version: "0.1.0" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["task_create", "task_get", "task_list", "task_update"])
    const created = await client.callTool({
      name: "task_create",
      arguments: { workspace: "/portable/workspace", run_id: "portable-run", subject: "Portable", description: "bundle-only runtime" },
    })
    assert.equal(created.structuredContent.result.subject, "Portable")
    assert.equal((await readdir(fixture)).includes("node_modules"), false)
  } finally {
    await client.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
