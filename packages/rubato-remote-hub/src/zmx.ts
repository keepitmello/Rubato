import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { isUuidV7, isZmxName, zmxNameForLiveSession, type LiveSessionId } from "@rubato/remote-protocol"
import { ensurePrivateDirectory, writePrivateFile } from "./files.js"
import type { DiscoveredProcess, LaunchRequest, ProcessController, ProcessDiscovery } from "./registry.js"

const execFileAsync = promisify(execFile)

export interface CommandRunner {
  run(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

export class ExecFileRunner implements CommandRunner {
  async run(file: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(file, [...args], { timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export class ZmxProcessAdapter implements ProcessDiscovery, ProcessController {
  readonly #zmx: string
  readonly #bootstrap: string
  readonly #descriptorRoot: string
  readonly #runner: CommandRunner

  constructor(input: { zmx: string; bootstrap: string; descriptorRoot: string; runner?: CommandRunner }) {
    this.#zmx = input.zmx
    this.#bootstrap = input.bootstrap
    this.#descriptorRoot = input.descriptorRoot
    this.#runner = input.runner ?? new ExecFileRunner()
  }

  async health(): Promise<void> {
    await this.#runner.run(this.#zmx, ["version"])
  }

  async discover(): Promise<readonly DiscoveredProcess[]> {
    let names: string[]
    try {
      const result = await this.#runner.run(this.#zmx, ["list", "--short"])
      names = result.stdout.split("\n").map((name) => name.trim()).filter(isZmxName)
    } catch {
      return []
    }
    const discovered = await Promise.all(names.map(async (name): Promise<DiscoveredProcess | null> => {
      const labels: Record<string, string> = {}
      for (const label of ["app", "rubato_live_id", "rubato_host_id", "rubato_protocol", "rubato_build_id"]) {
        try {
          labels[label] = (await this.#runner.run(this.#zmx, ["get", name, label])).stdout.trim()
        } catch {
          // An absent optional label does not invalidate discovery.
        }
      }
      const id = labels["rubato_live_id"]
      if (labels["app"] !== "rubato" || !isUuidV7(id) || zmxNameForLiveSession(id) !== name) return null
      let pid: number | undefined
      try {
        const parsed = Number((await this.#runner.run(this.#zmx, ["get", name, "pid"])).stdout.trim())
        if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed
      } catch {
        // PID is optional inventory metadata.
      }
      return { liveSessionId: id, zmxName: name, labels, ...(pid === undefined ? {} : { pid }) }
    }))
    return discovered.filter((entry): entry is DiscoveredProcess => entry !== null)
  }

  async launch(input: LaunchRequest): Promise<DiscoveredProcess> {
    await ensurePrivateDirectory(this.#descriptorRoot)
    const zmxName = zmxNameForLiveSession(input.liveSessionId)
    const descriptorPath = join(this.#descriptorRoot, `${input.liveSessionId}.json`)
    const descriptor = { schemaVersion: 1, socketPath: input.socketPath, token: input.launchToken }
    await writePrivateFile(descriptorPath, JSON.stringify(descriptor))
    const command = `exec ${quote(this.#bootstrap)} ${quote(descriptorPath)}`
    await this.#runner.run(this.#zmx, ["run", zmxName, "-d", command])
    await this.#runner.run(this.#zmx, ["set", zmxName, ...Object.entries(input.labels).map(([key, value]) => `${key}=${value}`)])
    let pid: number | undefined
    try {
      const parsed = Number((await this.#runner.run(this.#zmx, ["get", zmxName, "pid"])).stdout.trim())
      if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed
    } catch {
      // PID is optional inventory metadata.
    }
    return { liveSessionId: input.liveSessionId, zmxName, labels: input.labels, ...(pid === undefined ? {} : { pid }) }
  }

  async terminate(liveSessionId: LiveSessionId, force: boolean): Promise<void> {
    const args = ["kill", zmxNameForLiveSession(liveSessionId)]
    if (force) args.push("--force")
    await this.#runner.run(this.#zmx, args)
  }
}

export function quote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in command arguments")
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
