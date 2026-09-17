import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { log } from "@rubato/utils"

import type { RpcChildHandle, RpcRunnerSpec } from "./types"
import { RunnerError } from "./in-process/runner-error"
import { createRpcChildHandle } from "./rpc/handle"
import { createRpcModelAdmission, type ParentModelFinder, type RpcModelAdmission } from "./rpc/model-admission"
import { type MalformedLineHandler, RpcProtocolClient } from "./rpc/protocol-client"
import { type RpcSpawnDescriptor, buildRpcSpawn } from "./rpc/spawn"
import { discardUnstartedRpcHandle } from "./rpc/start-cleanup"

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

export type RpcProcessRunnerOptions = {
  readonly spawnChild?: (descriptor: RpcSpawnDescriptor) => ChildProcess
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly buildSpawn?: (spec: RpcRunnerSpec) => RpcSpawnDescriptor
  readonly heartbeatIntervalMs?: number
  readonly onMalformedLine?: MalformedLineHandler
  readonly now?: () => number
  readonly modelAdmission?: RpcModelAdmission
  // The parent session's live model registry. A model it resolves skips the child catalog probe
  // (see createRpcModelAdmission). Ignored when modelAdmission is supplied.
  readonly parentRegistry?: () => ParentModelFinder | undefined
  // The parent's `-e` extension entries, forwarded to every child so a detached process reproduces the
  // parent's extensions. Applied only when a spec does not already carry its own extensions.
  readonly inheritedExtensions?: readonly string[]
}

/**
 * Spawns a senpi RPC child (never shell:true) with an isolated session dir and
 * returns a steerable RpcChildHandle. The initial work is driven as a tracked
 * async prompt so callers can steer WHILE the turn is in flight. Process
 * destruction is exclusively via the single-writer terminate port (todo 12).
 */
export class RpcProcessRunner {
  private readonly spawnChild: (descriptor: RpcSpawnDescriptor) => ChildProcess
  private readonly buildSpawn: (spec: RpcRunnerSpec) => RpcSpawnDescriptor
  private readonly heartbeatIntervalMs: number
  private readonly onMalformedLine: MalformedLineHandler | undefined
  private readonly now: () => number
  private readonly modelAdmission: RpcModelAdmission
  private readonly inheritedExtensions: readonly string[]

  constructor(options: RpcProcessRunnerOptions = {}) {
    this.spawnChild =
      options.spawnChild ??
      ((descriptor) => defaultSpawnChild(descriptor, options.spawnProcess ?? spawn))
    this.buildSpawn = options.buildSpawn ?? ((spec) => buildRpcSpawn(spec))
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.onMalformedLine = options.onMalformedLine
    this.now = options.now ?? Date.now
    this.modelAdmission =
      options.modelAdmission ??
      createRpcModelAdmission(options.parentRegistry === undefined ? {} : { parentRegistry: options.parentRegistry })
    this.inheritedExtensions = options.inheritedExtensions ?? []
  }

  async start(specInput: RpcRunnerSpec): Promise<RpcChildHandle> {
    const spec =
      specInput.extensions === undefined && this.inheritedExtensions.length > 0
        ? { ...specInput, extensions: this.inheritedExtensions }
        : specInput
    await this.modelAdmission(spec)
    const descriptor = this.buildSpawn(spec)
    const child = this.spawnChild(descriptor)
    const client = new RpcProtocolClient({ child, onMalformedLine: this.onMalformedLine })
    const handle = createRpcChildHandle({
      client,
      child,
      taskId: spec.task_id,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      now: this.now,
    })
    const resume = spec.resumeSessionPath === undefined ? undefined : client.switchSession(spec.resumeSessionPath)
    if (resume === undefined) {
      // 초기 프롬프트를 기다리지 않는다. 자식은 별도 프로세스라 엔진(확장·스킬·MCP)을
      // 통째로 올린 뒤에야 prompt 명령에 응답하고, 그 부팅에만 12~28초가 걸린다(실측).
      // 그동안 start() 를 붙들면 부모의 Agent 도구 호출이 그만큼 멈추고, 부모 턴이
      // 도구 안에 갇혀 사용자의 스티어가 다음 도구 경계까지 못 들어간다.
      // in-process 러너는 이미 이렇게 동작한다 (createChildHandle 의 beginTurn).
      //
      // 실패는 버려지지 않는다: runPrompt 가 rethrow 하기 전에 이미 턴 결과를
      // child-prompt-failed 로 정산해 두므로, 매니저의 outcome 추적이 레코드를
      // fail 로 넘기고(모델 폴백이 있으면 그쪽으로 간다) 완료 핑이 부모에게 간다.
      //
      // 자식 프로세스는 여기서 죽이지 않는다. start() 가 돌아간 뒤로 그 자식은
      // 매니저의 #live 소유이고, 프롬프트 admission 이후에 실패한 턴
      // (child-turn-failed)도 프로세스를 남긴 채 레코드만 실패로 넘긴다.
      // 여기서만 따로 걷으면 매니저의 teardown 과 이중 종료가 된다.
      void handle.startInitialPrompt(spec.prompt).catch((error: unknown) => {
        log("senpi-task rpc initial prompt failed", { taskId: spec.task_id, error: String(error) })
      })
    } else {
      try {
        await resume
      } catch (error) {
        try {
          await discardUnstartedRpcHandle(handle)
        } catch (cleanupError) {
          log("senpi-task rpc start cleanup failed", { taskId: spec.task_id, error: String(cleanupError) })
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new RunnerError({ kind: "session_unavailable", message, cause: error })
      }
    }
    return Object.assign(handle, {
      spawnSpec: {
        cwd: spec.cwd,
        ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
        ...(spec.memberEnv === undefined ? {} : { memberEnv: spec.memberEnv }),
      },
      switchSession: (sessionPath: string) =>
        sessionPath === spec.resumeSessionPath && resume !== undefined
          ? resume
          : client.switchSession(sessionPath),
      getEntries: (since?: string) => client.getEntries(since),
    })
  }
}

function defaultSpawnChild(
  descriptor: RpcSpawnDescriptor,
  spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
): ChildProcess {
  return spawnProcess(descriptor.command, [...descriptor.args], {
    cwd: descriptor.cwd,
    env: descriptor.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  })
}
