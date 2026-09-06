import { describe, expect, it } from "bun:test"

import type { RpcRunnerSpec } from "../types"
import { createRpcModelAdmission, parentResolvesModel } from "./model-admission"
import type { RpcSpawnDescriptor } from "./spawn"

function descriptor(): RpcSpawnDescriptor {
  return { command: "senpi", args: ["--list-models"], cwd: "/tmp", env: { HOME: "/tmp" } }
}

function spec(model: string): RpcRunnerSpec {
  return { task_id: "st_parent_registry", cwd: "/tmp", state_dir: "/tmp/state", prompt: "hello", model }
}

function catalogOutput(models: readonly string[]): string {
  return ["provider  model", ...models.map((entry) => entry.replace("/", "  "))].join("\n")
}

function registryOf(...models: readonly string[]) {
  return { find: (provider: string, modelId: string) => (models.includes(`${provider}/${modelId}`) ? {} : undefined) }
}

describe("process model admission with the parent's live registry", () => {
  describe("#given the parent registry resolves the requested model", () => {
    it("#when admission runs #then the child catalog probe is skipped", async () => {
      // given
      let probes = 0
      const admit = createRpcModelAdmission({
        buildSpawn: () => descriptor(),
        probe: async () => {
          probes += 1
          return { code: 0, stdout: catalogOutput(["prov/alpha"]), stderr: "", timedOut: false }
        },
        parentRegistry: () => registryOf("prov/alpha"),
      })

      // when
      await admit(spec("prov/alpha"))

      // then
      expect(probes).toBe(0)
    })
  })

  describe("#given the parent registry does not resolve the requested model", () => {
    it("#when admission runs #then the child catalog probe still decides", async () => {
      // given
      let probes = 0
      const admit = createRpcModelAdmission({
        buildSpawn: () => descriptor(),
        probe: async () => {
          probes += 1
          return { code: 0, stdout: catalogOutput(["prov/beta"]), stderr: "", timedOut: false }
        },
        parentRegistry: () => registryOf("prov/alpha"),
      })

      // when
      await admit(spec("prov/beta"))

      // then
      expect(probes).toBe(1)
    })
  })

  describe("#given no parent registry exists yet", () => {
    it("#when admission runs #then the child catalog probe still decides", async () => {
      // given
      let probes = 0
      const admit = createRpcModelAdmission({
        buildSpawn: () => descriptor(),
        probe: async () => {
          probes += 1
          return { code: 0, stdout: catalogOutput(["prov/alpha"]), stderr: "", timedOut: false }
        },
        parentRegistry: () => undefined,
      })

      // when
      await admit(spec("prov/alpha"))

      // then
      expect(probes).toBe(1)
    })
  })

  describe("parentResolvesModel", () => {
    it("splits on the first slash and rejects edge slashes", () => {
      const registry = registryOf("openrouter/meta/llama")
      expect(parentResolvesModel(registry, "openrouter/meta/llama")).toBe(true)
      expect(parentResolvesModel(registry, "/meta")).toBe(false)
      expect(parentResolvesModel(registry, "openrouter/")).toBe(false)
      expect(parentResolvesModel(registry, "noslash")).toBe(false)
      expect(parentResolvesModel(undefined, "openrouter/meta/llama")).toBe(false)
    })
  })
})
