import { describe, expect, test } from "bun:test"
import { CIRCULAR_VALUE, REDACTED_VALUE, isSensitiveKey, redactSecrets, redactText } from "../src/index.js"

describe("secret redaction", () => {
  test("redacts sensitive fields recursively without mutating the source", () => {
    const sentinel = ["not", "a", "credential"].join("-")
    const source = {
      authorization: `Bearer ${sentinel}`,
      nested: {
        launch_token: sentinel,
        publicKey: "safe-public-material",
        message: `password=${sentinel}`,
      },
      entries: [{ apiKey: sentinel }, "ordinary text"],
    }

    expect(redactSecrets(source)).toEqual({
      authorization: REDACTED_VALUE,
      nested: {
        launch_token: REDACTED_VALUE,
        publicKey: "safe-public-material",
        message: `password=${REDACTED_VALUE}`,
      },
      entries: [{ apiKey: REDACTED_VALUE }, "ordinary text"],
    })
    expect(source.nested.launch_token).toBe(sentinel)
  })

  test("redacts bearer headers, assignments, token shapes, and private-key blocks in text", () => {
    const longPart = "abcdefghijklmnop"
    const privateBlock = `-----BEGIN PRIVATE KEY-----\n${longPart}\n-----END PRIVATE KEY-----`
    const text = `Authorization: Bearer ${longPart}.value api_key=${longPart} ghp_${longPart} ${privateBlock}`
    const redacted = redactText(text)

    expect(redacted).not.toContain(longPart)
    expect(redacted).toContain(`Bearer ${REDACTED_VALUE}`)
    expect(redacted).toContain(`api_key=${REDACTED_VALUE}`)
  })

  test("does not classify public keys as secrets", () => {
    expect(isSensitiveKey("private_key")).toBe(true)
    expect(isSensitiveKey("accessToken")).toBe(true)
    expect(isSensitiveKey("publicKey")).toBe(false)
    expect(isSensitiveKey("vapid_public_key")).toBe(false)
  })

  test("terminates safely on circular log metadata", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    expect(redactSecrets(cyclic)).toEqual({ self: CIRCULAR_VALUE })
  })
})
