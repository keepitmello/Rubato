#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { findStaleRuntimePersona, stageRuntimePersonas } from "./persona-artifacts.mjs"
import {
  OUTPUT_FAMILIES,
  TASK_RUNTIME_SPECIFIER,
  familyBuildDefines,
  familySiblingNames,
  outputFamilyFromMain,
} from "./output-family.mjs"

import {
  artifactsMatch,
  attachBuildMarker,
  minifyBundle,
  normalizeBuiltinImports,
  toPortableBuildPath,
} from "./build-artifact.mjs"

export { toPortableBuildPath }

export function resolveBunExecutable(platform = process.platform) {
  return platform === "win32" ? "bun.exe" : "bun"
}

// Keep this list byte-for-byte aligned with senpi loader.ts lines 145-165.
export const SENPI_LOADER_ALIASES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@code-yeongyu/senpi",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-tui",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/compat",
  "@mariozechner/pi-ai/oauth",
  "typebox",
  "typebox/compile",
  "typebox/value",
  "@sinclair/typebox",
  "@sinclair/typebox/compile",
  "@sinclair/typebox/value",
]

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(scriptDir)
const packageRoot = dirname(pluginRoot)
const repoRoot = join(packageRoot, "..", "..")
const entryPath = join(packageRoot, "src", "extension", "bundled-index.ts")
const outputPath = join(pluginRoot, "extensions", "rubato.js")
const taskEntryPath = join(packageRoot, "src", "extension", "rubato-task.ts")
const taskOutputPath = join(pluginRoot, "extensions", "rubato-task.js")
const memberEntryPath = join(repoRoot, "packages", "senpi-task", "src", "team", "member-extension", "index.ts")
const memberOutputPath = join(pluginRoot, "extensions", "rubato-member.js")
const memoryMcpEntryPath = join(packageRoot, "src", "mcp", "memory-server.ts")
const memoryMcpOutputPath = join(pluginRoot, "extensions", "rubato-memory-mcp.js")
const supervisorEntryPath = join(packageRoot, "src", "components", "memory", "worker", "memory-run-supervisor.ts")
const supervisorOutputPath = join(pluginRoot, "extensions", "memory-run-supervisor.mjs")
const builtinModuleNames = builtinModules
  .filter((moduleName) => !moduleName.startsWith("_"))
  .sort()
const liveSiblingName = familySiblingNames("rubato")
const externalSpecifiers = [
  TASK_RUNTIME_SPECIFIER,
  ...SENPI_LOADER_ALIASES,
  ...builtinModuleNames,
  ...builtinModuleNames.map((moduleName) => `node:${moduleName}`),
]
const BUILD_SETTINGS = JSON.stringify({
  target: "node",
  format: "esm",
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: false,
  secondaryMinifier: "terser@5.44.0",
  loaderAliases: SENPI_LOADER_ALIASES,
})

export async function buildExtension(options = {}) {
  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  if (typeof packageManifest.version !== "string" || packageManifest.version.length === 0) {
    throw new Error("Rubato runtime package manifest must contain a version")
  }
  const output = options.outputPath ?? outputPath
  const family = selectedOutputFamily(options, output)
  const buildDefines = {
    ...familyBuildDefines(family),
  }
  const taskOutput = resolveSiblingOutput(options, output, "taskOutputPath", "task")
  const memberOutput = resolveSiblingOutput(options, output, "memberOutputPath", "member")
  const memoryMcpOutput = resolveSiblingOutput(options, output, "memoryMcpOutputPath", "memoryMcp")
  const supervisorOutput = resolveSiblingOutput(options, output, "supervisorOutputPath", "supervisor")
  const mainInputs = await buildEntry(entryPath, output, buildDefines)
  const taskInputs = await buildEntry(taskEntryPath, taskOutput, buildDefines)
  const memberInputs = await buildEntry(memberEntryPath, memberOutput, buildDefines)
  const memoryMcpInputs = await buildEntry(memoryMcpEntryPath, memoryMcpOutput, buildDefines)
  const supervisorInputs = await buildEntry(supervisorEntryPath, supervisorOutput, buildDefines)
  // Bundling inlines assets.ts but its markdown is read from disk at runtime next to the bundle,
  // so the persona must be staged into the extension output directory the loader executes from.
  await Promise.all([
    stageRuntimePersonas(repoRoot, dirname(output)),
  ])
  return { mainInputs, taskInputs, memberInputs, memoryMcpInputs, supervisorInputs }
}

async function buildEntry(entry, output, buildDefines) {
  await mkdir(dirname(output), { recursive: true })
  const metafile = `${output}.meta.json`
  try {
    run(resolveBunExecutable(), [
      "build", entry, "--target", "node", "--format", "esm", "--outfile", output,
      "--minify-syntax", "--minify-whitespace", `--metafile=${metafile}`,
      ...Object.entries(buildDefines).flatMap(([name, value]) => ["--define", `${name}=${JSON.stringify(value)}`]),
      ...externalSpecifiers.flatMap((specifier) => ["--external", specifier]),
    ])
    await normalizeBuiltinImports(output, builtinModuleNames)
    await minifyBundle(output)
    return await attachBuildMarker({
      output,
      entry,
      metafile,
      buildDefines,
      repoRoot,
      buildSettings: BUILD_SETTINGS,
      buildScriptPath: fileURLToPath(import.meta.url),
    })
  } finally {
    await rm(metafile, { force: true })
  }
}

function selectedOutputFamily() {
  return outputFamilyFromMain()
}

export function resolveSiblingOutput(options, output, optionKey, siblingKey) {
  if (options[optionKey] !== undefined) return options[optionKey]
  const family = selectedOutputFamily(options, output)
  return join(dirname(output), OUTPUT_FAMILIES[family][siblingKey])
}

export const LIVE_SIBLING_NAMES = liveSiblingName

export async function checkExtensionCurrent(options = {}) {
  const output = options.outputPath ?? outputPath
  const family = selectedOutputFamily(options, output)
  const names = OUTPUT_FAMILIES[family]
  const taskOutput = resolveSiblingOutput(options, output, "taskOutputPath", "task")
  const memberOutput = resolveSiblingOutput(options, output, "memberOutputPath", "member")
  const memoryMcpOutput = resolveSiblingOutput(options, output, "memoryMcpOutputPath", "memoryMcp")
  const supervisorOutput = resolveSiblingOutput(options, output, "supervisorOutputPath", "supervisor")
  const currentMain = await readBuiltEntry(output)
  if (currentMain === undefined) return { ok: false, reason: "missing-output", output }
  const currentTask = await readBuiltEntry(taskOutput)
  if (currentTask === undefined) return { ok: false, reason: "missing-output", output: taskOutput }
  const currentMember = await readBuiltEntry(memberOutput)
  if (currentMember === undefined) return { ok: false, reason: "missing-output", output: memberOutput }
  const currentMemoryMcp = await readBuiltEntry(memoryMcpOutput)
  if (currentMemoryMcp === undefined) return { ok: false, reason: "missing-output", output: memoryMcpOutput }
  const currentSupervisor = await readBuiltEntry(supervisorOutput)
  if (currentSupervisor === undefined) return { ok: false, reason: "missing-output", output: supervisorOutput }

  const tempRoot = await mkdtemp(join(repoRoot, ".build-check-"))
  const expectedOutput = join(tempRoot, names.main)
  try {
    await buildExtension({
      outputPath: expectedOutput,
    })
    const expectedTaskOutput = join(tempRoot, names.task)
    const expectedMemberOutput = join(tempRoot, names.member)
    const expectedMemoryMcpOutput = join(tempRoot, names.memoryMcp)
    const expectedSupervisorOutput = join(tempRoot, names.supervisor)
    if (!artifactsMatch(currentMain, await readFile(expectedOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output }
    }
    if (!artifactsMatch(currentTask, await readFile(expectedTaskOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: taskOutput }
    }
    if (!artifactsMatch(currentMember, await readFile(expectedMemberOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: memberOutput }
    }
    if (!artifactsMatch(currentMemoryMcp, await readFile(expectedMemoryMcpOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: memoryMcpOutput }
    }
    if (!artifactsMatch(currentSupervisor, await readFile(expectedSupervisorOutput, "utf8"))) {
      return { ok: false, reason: "stale-output", output: supervisorOutput }
    }
    const stalePersona = await findStaleRuntimePersona(tempRoot, dirname(output), repoRoot)
    if (stalePersona !== undefined) return { ok: false, reason: "stale-output", output: stalePersona }
    return { ok: true, output, taskOutput, memberOutput }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function digestBuildSources(metadata, entry, buildDefines) {
  const inputs = metadata !== null && typeof metadata === "object" && metadata.inputs !== null
    && typeof metadata.inputs === "object" ? Object.keys(metadata.inputs).sort() : []
  const hash = createHash("sha256")
    .update(BUILD_SETTINGS)
    .update(JSON.stringify(buildDefines))
    .update(toPortableBuildPath(relative(repoRoot, entry)))
  for (const input of inputs) {
    const inputPath = resolve(repoRoot, input)
    hash.update(toPortableBuildPath(relative(repoRoot, inputPath))).update(await readFile(inputPath))
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)))
  return hash.digest("hex")
}

function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code
}

async function readBuiltEntry(output) {
  try {
    return await readFile(output, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    run("node", [join(scriptDir, "stage-lsp-daemon-runtime.mjs"), "--check"])
    run("node", [join(scriptDir, "stage-ast-grep-mcp-runtime.mjs"), "--check"])
    const result = await checkExtensionCurrent()
    if (!result.ok) {
      console.error(`Rubato extension build is not current: ${result.reason}`)
      console.error(`output=${result.output}`)
      process.exit(1)
    }
    console.log(`Rubato extension build is current: ${result.output}`)
  } else {
    await buildExtension()
    console.log(
      `Built Rubato extensions: ${outputPath}, ${taskOutputPath}, ${memberOutputPath}, ${memoryMcpOutputPath}, ${supervisorOutputPath}`,
    )
  }
}
