import { userInfo } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import { toPosixPath } from "../internal/posix-path"
import { DEFAULT_READ_FILE_SYSTEM, type RubatoConfigEnv, type RubatoConfigReadFileSystem } from "./types"

export type RubatoConfigPathCandidate = {
  readonly path: string
  readonly scope: "project" | "user"
}

export type ResolveRubatoConfigPathsOptions = {
  readonly cwd: string
  readonly env?: RubatoConfigEnv
  readonly fileSystem?: RubatoConfigReadFileSystem
  readonly platform?: NodeJS.Platform
}

export const MAX_PROJECT_CONFIG_DIRECTORY_DEPTH = 256

const ACCOUNT_HOME_DIR = userInfo().homedir

export function resolveHomeDir(env: RubatoConfigEnv = process.env): string {
  const homeDir = env.HOME ?? env.USERPROFILE ?? process.cwd()
  return homeDir.startsWith("/") ? posix.resolve(homeDir) : toPosixPath(resolve(homeDir))
}

export function resolveUserRubatoConfigPath(env: RubatoConfigEnv = process.env): string {
  return join(resolveUserRubatoConfigDirectory(env), "rubato.jsonc")
}

export function resolveUserRubatoConfigDirectory(env: RubatoConfigEnv = process.env): string {
  return join(resolveHomeDir(env), ".rubato")
}

function detectUserRubatoJsonPath(env: RubatoConfigEnv, fileSystem: RubatoConfigReadFileSystem): string {
  const configDir = resolveUserRubatoConfigDirectory(env)
  const jsoncPath = join(configDir, "rubato.jsonc")
  if (fileSystem.existsSync(jsoncPath)) return jsoncPath
  const jsonPath = join(configDir, "rubato.json")
  return fileSystem.existsSync(jsonPath) ? jsonPath : jsoncPath
}

function isSymlinkedProjectPath(path: string, fileSystem: RubatoConfigReadFileSystem): boolean {
  if (fileSystem.lstatSync === undefined || !fileSystem.existsSync(path)) return false
  try {
    return fileSystem.lstatSync(path).isSymbolicLink()
  } catch (error) {
    if (error instanceof Error) return true
    throw error
  }
}

function isLoadableProjectConfigFile(path: string, fileSystem: RubatoConfigReadFileSystem): boolean {
  return fileSystem.existsSync(path) && !isSymlinkedProjectPath(path, fileSystem)
}

function detectRubatoJsonPath(dir: string, fileSystem: RubatoConfigReadFileSystem): string | null {
  const rubatoDir = join(dir, ".rubato")
  if (isSymlinkedProjectPath(rubatoDir, fileSystem)) return null
  const jsoncPath = join(rubatoDir, "rubato.jsonc")
  if (isLoadableProjectConfigFile(jsoncPath, fileSystem)) return jsoncPath
  const jsonPath = join(rubatoDir, "rubato.json")
  return isLoadableProjectConfigFile(jsonPath, fileSystem) ? jsonPath : null
}

function realpathOrSelf(path: string, fileSystem: RubatoConfigReadFileSystem): string {
  if (fileSystem.realpathSync === undefined) return path
  try {
    return fileSystem.realpathSync(path)
  } catch {
    return path
  }
}

export function findProjectConfigPathsFarthestFirst(
  cwd: string,
  homeDir: string,
  fileSystem: RubatoConfigReadFileSystem,
  accountHomeDir: string = homeDir,
): readonly string[] {
  // process.cwd(), HOME, and the account home can disagree in symlink form
  // (/var vs /private/var), so compare real paths while returned candidates
  // keep the caller's path form.
  const startDir = resolve(cwd)
  const boundaryDirs = [...new Set([resolve(homeDir), resolve(accountHomeDir)])]
  const realBoundaryDirs = new Set(boundaryDirs.map((path) => realpathOrSelf(path, fileSystem)))
  const nearestFirst: string[] = []
  let currentDir = startDir

  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH; depth += 1) {
    const isHomeDir = boundaryDirs.includes(currentDir) || realBoundaryDirs.has(realpathOrSelf(currentDir, fileSystem))
    // A home `.rubato` is a user layer, so the walk must not also claim it as a project layer.
    const configPath = isHomeDir ? null : detectRubatoJsonPath(currentDir, fileSystem)
    if (configPath !== null) nearestFirst.push(configPath)
    if (isHomeDir) break
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return nearestFirst.reverse()
}

export function resolveRubatoConfigPaths(options: ResolveRubatoConfigPathsOptions): readonly RubatoConfigPathCandidate[] {
  const fileSystem = options.fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  const env = options.env ?? process.env
  const userPath = detectUserRubatoJsonPath(env, fileSystem)
  const projectPaths = findProjectConfigPathsFarthestFirst(options.cwd, resolveHomeDir(env), fileSystem, ACCOUNT_HOME_DIR)
  return [
    { path: userPath, scope: "user" },
    ...projectPaths.map((path): RubatoConfigPathCandidate => ({ path, scope: "project" })),
  ]
}
