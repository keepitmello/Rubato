import { describe, expect, test } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { MemoryFakeExtensionAPI } from "./memory.test-support"
import { missingMemoryCapabilities } from "./capabilities"

describe("missingMemoryCapabilities", () => {
  test("#given the real memory persistence surface #when checked #then no capability is missing", () => {
    expect(missingMemoryCapabilities(new MemoryFakeExtensionAPI())).toEqual([])
  })

  test("#given a host missing custom-entry APIs #when checked #then both required capabilities are reported", () => {
    const pi = new FakeExtensionAPI()
    ;(pi as { appendEntry?: unknown }).appendEntry = undefined
    ;(pi as { registerEntryRenderer?: unknown }).registerEntryRenderer = undefined
    expect(missingMemoryCapabilities(pi)).toEqual(["appendEntry", "registerEntryRenderer"])
  })
})
