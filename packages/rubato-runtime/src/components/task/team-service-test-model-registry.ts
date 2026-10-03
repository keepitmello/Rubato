import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ModelRegistry as SenpiModelRegistry } from "@earendil-works/pi-coding-agent"
import { ModelRegistry, ModelRuntime } from "../../senpi-test-runtime"

// Stock pi only builds a ModelRuntime asynchronously. The callers are synchronous fixtures that never
// mutate the registry, so they share one empty runtime and re-register the same providers.
const runtimeDir = mkdtempSync(join(tmpdir(), "rubato-team-service-registry-"))
const sharedModelRuntime = await ModelRuntime.create({ authPath: join(runtimeDir, "auth.json"), modelsPath: null })

export function createTeamServiceTestModelRegistry(): SenpiModelRegistry {
  const modelRegistry = new ModelRegistry(sharedModelRuntime)
  modelRegistry.registerProvider("xai", {
    api: "openai-completions",
    baseUrl: "https://example.test",
    apiKey: "test-key",
    models: [{
      id: "grok-4.7",
      name: "Grok 4.7",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    }],
  })
  modelRegistry.registerProvider("rubato-mock", {
    api: "openai-completions",
    baseUrl: "https://example.test",
    apiKey: "test-key",
    models: [{
      id: "mock-1",
      name: "Mock model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    }],
  })
  return modelRegistry
}
