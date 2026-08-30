import { parse, printParseErrorCode } from "jsonc-parser/lib/esm/main.js"

import { RubatoCodegraphSettingsSchema, RubatoConfigLayerSchema, RubatoConfigSchema, resolveRubatoTaskSettings, type RubatoConfig } from "../schema"
import { mergeRubatoConfigRecords } from "./merge"
import { resolveRubatoConfigPaths } from "./paths"
import { resolveRubatoConfigView, resolveRubatoProfileName } from "./resolution"
import {
  DEFAULT_READ_FILE_SYSTEM,
  type LoadRubatoConfigOptions,
  type LoadRubatoConfigResult,
  type RubatoConfigDiagnostic,
  type RubatoConfigRawLayer,
  type RubatoConfigReadFileSystem,
  type RubatoConfigSource,
} from "./types"

type JsoncParseResult<T> = {
  readonly data: T | null
  readonly errors: readonly { readonly message: string; readonly offset: number }[]
}

function parseJsoncSafe<T>(content: string): JsoncParseResult<T> {
  const errors: { error: number; length: number; offset: number }[] = []
  const data = parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T | null

  return {
    data: errors.length === 0 ? data : null,
    errors: errors.map((error) => ({
      message: printParseErrorCode(error.error),
      offset: error.offset,
    })),
  }
}

const DEFAULT_RAW_CONFIG: Record<string, unknown> = {
  agents: {},
  categories: {},
  codegraph: RubatoCodegraphSettingsSchema.parse({}),
  task: resolveRubatoTaskSettings({}),
  teams: {},
}

function stripResolutionControlKeys(config: RubatoConfig): RubatoConfig {
  const {
    "[codex]": _codex,
    "[opencode]": _opencode,
    "[senpi]": _senpi,
    profiles: _profiles,
    ...resolved
  } = config
  return resolved
}

function validationDiagnostic(path: string, issues: readonly { readonly path: readonly PropertyKey[] }[]): RubatoConfigDiagnostic {
  const issuePaths = issues.map((issue) => issue.path.map((segment) => String(segment)).join("."))
  return {
    kind: "validation",
    message: `Invalid rubato config at ${path}: ${issuePaths.join(", ")}`,
    path,
    issuePaths,
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry
  }
  return record
}

function readConfigSource(
  path: string,
  scope: "project" | "user",
  fileSystem: RubatoConfigReadFileSystem,
): {
  readonly diagnostic?: RubatoConfigDiagnostic
  readonly source: RubatoConfigSource
  readonly value?: Record<string, unknown>
} {
  if (!fileSystem.existsSync(path)) {
    return { source: { exists: false, loaded: false, path, scope } }
  }

  let content: string
  try {
    content = fileSystem.readFileSync(path, "utf-8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      diagnostic: { kind: "read", message: `Failed to read ${path}: ${message}`, path },
      source: { exists: true, loaded: false, path, scope },
    }
  }

  const parsed = parseJsoncSafe<unknown>(content)
  if (parsed.errors.length > 0) {
    return {
      diagnostic: {
        kind: "parse",
        message: `JSONC parse error in ${path}: ${parsed.errors.map((error) => error.message).join(", ")}`,
        path,
      },
      source: { exists: true, loaded: false, path, scope },
    }
  }

  const validation = RubatoConfigLayerSchema.safeParse(parsed.data)
  if (!validation.success) {
    return {
      diagnostic: validationDiagnostic(path, validation.error.issues),
      source: { exists: true, loaded: false, path, scope },
    }
  }
  const parsedRecord = toRecord(parsed.data)
  if (parsedRecord === null) {
    return {
      diagnostic: { kind: "validation", message: `Invalid rubato config at ${path}: root must be an object`, path },
      source: { exists: true, loaded: false, path, scope },
    }
  }

  return {
    source: { exists: true, loaded: true, path, scope },
    value: parsedRecord,
  }
}

export function loadRubatoConfig(options: LoadRubatoConfigOptions = {}): LoadRubatoConfigResult {
  const fileSystem = options.fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  const cwd = options.cwd ?? process.cwd()
  let merged: Record<string, unknown> = {}
  const diagnostics: RubatoConfigDiagnostic[] = []
  const layers: RubatoConfigRawLayer[] = []
  const sources: RubatoConfigSource[] = []

  for (const candidate of resolveRubatoConfigPaths({
    cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    fileSystem,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })) {
    const loaded = readConfigSource(candidate.path, candidate.scope, fileSystem)
    sources.push(loaded.source)
    if (loaded.diagnostic !== undefined) diagnostics.push(loaded.diagnostic)
    if (loaded.value !== undefined) {
      layers.push({ config: loaded.value, source: loaded.source })
      merged = mergeRubatoConfigRecords(merged, loaded.value)
    }
  }

  const requestedProfile = resolveRubatoProfileName({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  })
  const resolved = resolveRubatoConfigView({
    config: merged,
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(requestedProfile === undefined ? {} : { profile: requestedProfile }),
  })
  const finalConfig = RubatoConfigSchema.safeParse(mergeRubatoConfigRecords(DEFAULT_RAW_CONFIG, resolved.config))
  if (finalConfig.success) {
    return {
      config: stripResolutionControlKeys(finalConfig.data),
      diagnostics: [...diagnostics, ...resolved.diagnostics],
      layers,
      ...(resolved.profile === undefined ? {} : { profile: resolved.profile }),
      sources,
    }
  }

  return {
    config: stripResolutionControlKeys(RubatoConfigSchema.parse(DEFAULT_RAW_CONFIG)) satisfies RubatoConfig,
    diagnostics: [...diagnostics, ...resolved.diagnostics, validationDiagnostic("(merged rubato config)", finalConfig.error.issues)],
    layers,
    ...(resolved.profile === undefined ? {} : { profile: resolved.profile }),
    sources,
  }
}
