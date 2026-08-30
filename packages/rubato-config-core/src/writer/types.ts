import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import type { RubatoConfigEnv } from "../loader"

export type RubatoConfigEditPathSegment = string | number

export type RubatoConfigEdit = {
  readonly path: readonly RubatoConfigEditPathSegment[]
  readonly value: unknown
}

export type RubatoConfigPathStats = {
  readonly isSymbolicLink: () => boolean
}

export type RubatoConfigWriteFileSystem = {
  readonly copyFileSync: (source: string, destination: string) => void
  readonly existsSync: (path: string) => boolean
  readonly lstatSync: (path: string) => RubatoConfigPathStats
  readonly mkdirSync: (path: string, options: { readonly recursive: true }) => string | undefined
  readonly readFileSync: (path: string, encoding: "utf-8") => string
  readonly readdirSync: (path: string) => string[]
  readonly renameSync: (oldPath: string, newPath: string) => void
  readonly unlinkSync: (path: string) => void
  readonly writeFileExclusiveSync: (path: string, content: string) => void
  readonly writeFileSync: (path: string, content: string, encoding: "utf-8") => void
}

export type UpdateRubatoConfigOptions = {
  readonly edits: readonly RubatoConfigEdit[]
  readonly env?: RubatoConfigEnv
  readonly fileSystem?: RubatoConfigWriteFileSystem
  readonly platform?: NodeJS.Platform
  readonly projectDir?: string
  readonly scope: "project" | "user"
  readonly targetPath?: string
}

export type UpdateRubatoConfigResult = {
  readonly backupPath?: string
  readonly path: string
}

export const DEFAULT_WRITE_FILE_SYSTEM: RubatoConfigWriteFileSystem = {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileExclusiveSync: (path: string, content: string): void => {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" })
  },
  writeFileSync,
}

export class RubatoConfigWriteError extends Error {
  override readonly name = "RubatoConfigWriteError"

  constructor(
    readonly path: string,
    readonly operation: "backup" | "parse" | "read" | "write",
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to ${operation} rubato config at ${path}: ${detail}`, { cause })
  }
}
