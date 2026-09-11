#!/usr/bin/env node
import { BoardError, openBoard } from "./board.js"

const operation = process.argv[2]
const rawInput = process.argv[3] ?? "{}"

if (!new Set(["create", "list", "get", "update"]).has(operation)) {
  console.error("usage: taskforce <create|list|get|update> '<json>'")
  process.exitCode = 2
} else {
  let board
  try {
    const input = JSON.parse(rawInput)
    board = openBoard()
    const result = board[operation](input)
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
  } catch (error) {
    const payload = error instanceof BoardError
      ? { ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }
      : { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    process.exitCode = 1
  } finally {
    board?.close()
  }
}
