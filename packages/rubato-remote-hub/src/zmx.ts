import { execFile, spawn } from "node:child_process"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { isUuidV7, isZmxName, zmxNameForLiveSession, type LiveSessionId } from "@rubato/remote-protocol"
import { ensurePrivateDirectory, writePrivateFile } from "./files.js"
import type { DiscoveredProcess, LaunchRequest, ProcessController, ProcessDiscovery } from "./registry.js"

const execFileAsync = promisify(execFile)

export interface CommandRunner {
  run(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

export interface DetachedCommandLauncher {
  launch(file: string, args: readonly string[]): Promise<void>
}

export class ExecFileRunner implements CommandRunner {
  async run(file: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(file, [...args], { timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export class SpawnDetachedCommandLauncher implements DetachedCommandLauncher {
  async launch(file: string, args: readonly string[]): Promise<void> {
    const environment: NodeJS.ProcessEnv = { ...process.env, ZMX_NO_DETACH_KEY: "1" }
    delete environment["ZMX_SESSION"]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, [...args], { detached: true, stdio: "ignore", env: environment })
      child.once("spawn", () => {
        child.unref()
        resolve()
      })
      child.once("error", reject)
    })
  }
}

export class ZmxProcessAdapter implements ProcessDiscovery, ProcessController {
  readonly #zmx: string
  readonly #bootstrap: string
  readonly #descriptorRoot: string
  readonly #runner: CommandRunner
  readonly #launcher: DetachedCommandLauncher

  constructor(input: { zmx: string; bootstrap: string; descriptorRoot: string; runner?: CommandRunner; launcher?: DetachedCommandLauncher }) {
    this.#zmx = input.zmx
    this.#bootstrap = input.bootstrap
    this.#descriptorRoot = input.descriptorRoot
    this.#runner = input.runner ?? new ExecFileRunner()
    this.#launcher = input.launcher ?? new SpawnDetachedCommandLauncher()
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
    const labels = Object.entries(input.labels).map(([key, value]) => `${key}=${value}`)
    try {
      await this.#launcher.launch(this.#zmx, ["attach", "--labels", labels.join(" "), zmxName, this.#bootstrap, descriptorPath])
      await this.#waitForLabel(zmxName, "app", input.labels["app"] ?? "rubato")
    } catch (cause) {
      await this.#runner.run(this.#zmx, ["kill", zmxName, "--force"]).catch(() => {})
      throw cause
    }
    let pid: number | undefined
    try {
      const parsed = Number((await this.#runner.run(this.#zmx, ["get", zmxName, "pid"])).stdout.trim())
      if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed
    } catch {
      // PID is optional inventory metadata.
    }
    return { liveSessionId: input.liveSessionId, zmxName, labels: input.labels, ...(pid === undefined ? {} : { pid }) }
  }

  async #waitForLabel(zmxName: string, key: string, expected: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await this.#runner.run(this.#zmx, ["get", zmxName, key], { timeoutMs: 1_000 })).stdout.trim() === expected) return
      } catch {
        // The detached attach client may still be creating the daemon.
      }
      await delay(20)
    }
    throw new Error(`zmx session ${zmxName} did not become ready`)
  }

  async terminate(liveSessionId: LiveSessionId, force: boolean): Promise<void> {
    const args = ["kill", zmxNameForLiveSession(liveSessionId)]
    if (force) args.push("--force")
    await this.#runner.run(this.#zmx, args)
  }
}
