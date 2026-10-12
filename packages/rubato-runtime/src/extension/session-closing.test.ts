/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { FakeExtensionAPI } from "../../test-support/fake-extension-api"
import { createSessionClosing } from "./session-closing"

describe("createSessionClosing", () => {
  it("#given subscribers #when its extension hears session_shutdown #then every subscriber runs and an unsubscribed one does not", async () => {
    const closing = createSessionClosing()
    const pi = new FakeExtensionAPI()
    closing.extension(pi)
    const heard: string[] = []
    closing.subscribe(() => heard.push("a"))
    const unsubscribe = closing.subscribe(() => heard.push("b"))
    closing.subscribe(() => heard.push("c"))
    unsubscribe()

    await pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "unload" })

    expect(heard).toEqual(["a", "c"])
  })

  it("#given a subscriber that throws #when the session closes #then the rest still run and the error surfaces", async () => {
    const closing = createSessionClosing()
    const pi = new FakeExtensionAPI()
    closing.extension(pi)
    const heard: string[] = []
    closing.subscribe(() => {
      throw new Error("boom")
    })
    closing.subscribe(() => heard.push("after"))

    await expect(pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "unload" })).rejects.toThrow("boom")
    expect(heard).toEqual(["after"])
  })
})
