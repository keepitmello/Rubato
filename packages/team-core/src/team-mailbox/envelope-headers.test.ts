/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import type { Message } from "../types"
import { buildEnvelope, readEnvelopeHeaders } from "./poll"

const message = (overrides: Partial<Message>): Message => ({
  version: 1,
  messageId: "00000000-0000-4000-8000-000000000001",
  from: "lead",
  to: "engine",
  kind: "message",
  body: "body with \"quotes\" and <tags>",
  timestamp: 1,
  ...overrides,
})

describe("readEnvelopeHeaders", () => {
  test("#given a batch of envelopes #then each sender and summary come back in order, unescaped", () => {
    const content = [
      buildEnvelope(message({ summary: "Fix the \"dawn\" sleep <now>" })),
      buildEnvelope(message({ from: "hub", kind: "announcement" })),
    ].join("\n\n")
    expect(readEnvelopeHeaders(content)).toEqual([
      { from: "lead", summary: "Fix the \"dawn\" sleep <now>" },
      { from: "hub" },
    ])
  })

  test("#given text with no envelope #then nothing", () => {
    expect(readEnvelopeHeaders("plain text")).toEqual([])
  })
})
