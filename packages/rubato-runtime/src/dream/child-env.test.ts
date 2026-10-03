import { describe, expect, test } from "bun:test"

import { childEnv } from "./child-env"

describe("childEnv", () => {
  // 2026-10-04: a dream started from inside a notes-mode session failed on every rung at the notes gate.
  test("#given a caller session's identity and context mode #when the dream child env is built #then neither is passed on and the profile is pinned", () => {
    const env = childEnv({
      HOME: "/home/u", PATH: "/bin",
      PI_SESSION_ID: "s1", PI_MODEL: "m", RUBATO_CONTEXT_MODE: "history-notes", RUBATO_CONTEXT_MODE_ORIGIN: "session",
    })
    expect(env.PI_SESSION_ID).toBeUndefined()
    expect(env.PI_MODEL).toBeUndefined()
    expect(env.RUBATO_CONTEXT_MODE).toBeUndefined()
    expect(env.RUBATO_CONTEXT_MODE_ORIGIN).toBeUndefined()
    expect(env.PI_CODING_AGENT_DIR).toBe("/home/u/.rubato-pi/agent")
    expect(env.PATH).toBe("/bin")
  })
})
