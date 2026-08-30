import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import type { RubatoConfig, RubatoHarnessId } from "../schema"

export type RubatoConfigDiagnosticKind = "parse" | "profile" | "read" | "validation"

export type RubatoConfigDiagnostic = {
  readonly kind: RubatoConfigDiagnosticKind
  readonly path: string
  readonly message: string
  readonly issuePaths?: readonly string[]
}

export type RubatoConfigSourceScope = "project" | "user"

export type RubatoConfigSource = {
  readonly exists: boolean
  readonly loaded: boolean
  readonly path: string
  readonly scope: RubatoConfigSourceScope
}

export type RubatoConfigEnv = {
  readonly [key: string]: string | undefined
  readonly HOME?: string
  readonly USERPROFILE?: string
}

export type RubatoConfigReadFileSystem = {
  readonly existsSync: (path: string) => boolean
  readonly lstatSync?: (path: string) => { readonly isSymbolicLink: () => boolean }
  readonly readFileSync: (path: string, encoding: "utf-8") => string
  readonly realpathSync?: (path: string) => string
}

export type RubatoConfigRawLayer = {
  readonly config: Readonly<Record<string, unknown>>
  readonly source: RubatoConfigSource
}

export type LoadRubatoConfigOptions = {
  readonly cwd?: string
  readonly env?: RubatoConfigEnv
  readonly fileSystem?: RubatoConfigReadFileSystem
  readonly harness?: RubatoHarnessId
  readonly platform?: NodeJS.Platform
  readonly profile?: string
}

export type LoadRubatoConfigResult = {
  readonly config: RubatoConfig
  readonly diagnostics: readonly RubatoConfigDiagnostic[]
  readonly layers: readonly RubatoConfigRawLayer[]
  readonly profile?: string
  readonly sources: readonly RubatoConfigSource[]
}

export const DEFAULT_READ_FILE_SYSTEM: RubatoConfigReadFileSystem = {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
}
