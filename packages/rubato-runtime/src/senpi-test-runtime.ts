import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const senpiDistDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))

const themeModule = await import(pathToFileURL(join(
  senpiDistDir,
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href) as Pick<typeof import("@earendil-works/pi-coding-agent"), "Theme">

const modelRegistryModule = await import(
  pathToFileURL(join(senpiDistDir, "core", "model-registry.js")).href
) as Pick<typeof import("@earendil-works/pi-coding-agent"), "ModelRegistry">

const modelRuntimeModule = await import(
  pathToFileURL(join(senpiDistDir, "core", "model-runtime.js")).href
) as Pick<typeof import("@earendil-works/pi-coding-agent"), "ModelRuntime">

export const { Theme } = themeModule
export const { ModelRegistry } = modelRegistryModule
export const { ModelRuntime } = modelRuntimeModule
