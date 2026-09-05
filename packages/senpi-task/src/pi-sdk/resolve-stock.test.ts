import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readFileSync } from "node:fs"
import { applyNonInteractiveBashCompat, SENPI_PIPE_BASH_ENV, STOCK_PIPE_BASH_ENV } from "./pty-compat.ts"
import { resolveStockCodingAgent, StockPiSdkError } from "./resolve-stock.ts"
import { CODEMODE_PTY_CONSUMERS } from "./codemode-pty-boundary.ts"

describe("resolveStockCodingAgent", () => {
  test("#given the persistent candidate #when resolved #then it is stock Pi 0.84.2 not Senpi", () => {
    const root = resolveStockCodingAgent({
      RUBATO_PI_SDK: "/tmp/rubato-pi-candidate-3bd2ec525",
    })
    expect(root.endsWith("/rubato-pi-candidate-3bd2ec525")).toBe(true)
    expect(root.includes("@code-yeongyu")).toBe(false)
  })

  test("#given a Senpi package path #when resolved #then it is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "fake-senpi-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "@code-yeongyu/senpi",
      version: "2026.9.4-3",
    }))
    try {
      expect(() => resolveStockCodingAgent({ RUBATO_PI_SDK: root })).toThrow(StockPiSdkError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a missing env path #when resolved #then it does not fall through to worktree Senpi", () => {
    const missing = join(tmpdir(), "rubato-pi-sdk-missing-")
    expect(() => resolveStockCodingAgent({ RUBATO_PI_SDK: missing })).toThrow(/stock Pi 0.84.2/)
  })

  test("#given no RUBATO_PI_SDK #when resolved #then it does not use a hardcoded /tmp candidate", () => {
    expect(() => resolveStockCodingAgent({})).toThrow(/stock Pi 0.84.2 coding-agent not found/)
  })
})

describe("applyNonInteractiveBashCompat", () => {
  test("#given a child env #when applied #then both pipe flags are set without dropping caller keys", () => {
    const env = applyNonInteractiveBashCompat({ HOME: "/tmp/isolated-home", PATH: "/usr/bin" })
    expect(env[SENPI_PIPE_BASH_ENV]).toBe("1")
    expect(env[STOCK_PIPE_BASH_ENV]).toBe("1")
    expect(env.HOME).toBe("/tmp/isolated-home")
  })
})

describe("reject relative stock paths", () => {
  test("#given a relative RUBATO_PI_SDK #when resolved #then it fails closed", () => {
    expect(() => resolveStockCodingAgent({ RUBATO_PI_SDK: "node_modules/@code-yeongyu/senpi" })).toThrow(/absolute/)
  })
})

test("#given resolve-stock source #when inspected #then it has no hardcoded /tmp candidate", () => {
  const src = readFileSync(new URL("./resolve-stock.ts", import.meta.url), "utf8")
  expect(src.includes("/tmp/rubato-pi-candidate")).toBe(false)
  expect(src.includes("/tmp/pi-rg-fixture")).toBe(false)
})

test("#given PTY inventory #when listed #then detached pipe is not claimed as interactive parity", () => {
  expect(CODEMODE_PTY_CONSUMERS.some((item) => item.id === "rubato-terminal-bridge" && item.pty === true)).toBe(true)
  expect(CODEMODE_PTY_CONSUMERS.some((item) => item.id === "memory-child-launch" && item.pty === "pipe-override-only")).toBe(true)
  expect(CODEMODE_PTY_CONSUMERS.some((item) => item.id === "stock-bash" && item.pty === false)).toBe(true)
})
