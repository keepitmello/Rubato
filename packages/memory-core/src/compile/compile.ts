import type { GitMemoryRepo } from "../git"
import { parseMemoryFile } from "../memfs/frontmatter"
import {
  renderSystemTree,
  type CompiledSystemFile,
} from "./render"

const PERSONA_PATH = "system/persona.md"
const IDENTITY_PATH = "system/identity.md"
const REMINDER =
  "Reminder: <projection> holds local paths of memory projections. <memory> is your persistent memory across conversations. Consult it BEFORE asking the user anything it may already answer. Save durable facts, preferences, decisions, and corrections with the memory tools THE MOMENT they emerge. Route facts about a person to their record under people/; the primary human's card is people/human/card.md, or system/human.md in a repository that still carries that older file."

export interface CompileMemoryBlockOptions {
  agentId: string
  /**
   * Whitelist of `system/*.md` paths to inline into the system prompt.
   * Empty or omitted means nothing from the memory repository is projected —
   * metadata only. Non-system paths, skills, and unlisted system files stay
   * reachable through the memory tools and are never listed as a names-only
   * tree. Adding a future `system/soul.md` is a config change, not a code change.
   */
  project?: readonly string[]
}

export function normalizeProject(project: readonly string[] | undefined): string[] {
  if (project === undefined || project.length === 0) return []
  const out = new Set<string>()
  for (const raw of project) {
    const path = raw.trim().replace(/^\.?\//, "")
    if (!isProjectableSystemPath(path)) continue
    out.add(path)
  }
  return [...out].sort()
}

export function isProjectableSystemPath(path: string): boolean {
  return path.startsWith("system/") && path.endsWith(".md") && !path.includes("..") && !path.includes("\0")
}

export async function compileMemoryBlock(
  repo: GitMemoryRepo,
  options: CompileMemoryBlockOptions,
): Promise<string> {
  return compileMemoryBlockAtRevision(repo, await repo.head(), options)
}

export async function compileMemoryBlockAtRevision(
  repo: GitMemoryRepo,
  revision: string | null,
  options: CompileMemoryBlockOptions,
): Promise<string> {
  const project = normalizeProject(options.project)
  if (project.length === 0) return renderMetadata(options)
  const paths = revision ? await repo.lsTree(revision) : []
  const available = new Set(paths)
  const listed = project.filter((path) => available.has(path))
  const persona = revision && listed.includes(PERSONA_PATH)
    ? await readSystemFile(repo, revision, PERSONA_PATH)
    : undefined
  const identity = revision && listed.includes(IDENTITY_PATH)
    ? await readSystemFile(repo, revision, IDENTITY_PATH)
    : undefined
  const otherListed = listed.filter((path) => path !== PERSONA_PATH && path !== IDENTITY_PATH)
  const systemFiles = revision
    ? await readSystemFiles(repo, revision, otherListed)
    : []
  const projection = renderProjection(persona, identity, systemFiles)
  const metadata = renderMetadata(options)
  return [projection, metadata].filter((part) => part.length > 0).join("\n\n")
}

async function readSystemFiles(
  repo: GitMemoryRepo,
  revision: string,
  paths: readonly string[],
): Promise<CompiledSystemFile[]> {
  const files = await Promise.all(paths.map((path) => readSystemFile(repo, revision, path)))
  return files.filter((file): file is CompiledSystemFile => file !== undefined)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function readSystemFile(
  repo: GitMemoryRepo,
  revision: string,
  relativePath: string,
): Promise<CompiledSystemFile | undefined> {
  try {
    const parsed = parseMemoryFile(await repo.show(revision, relativePath))
    return {
      relativePath,
      body: parsed.body,
      description: parsed.frontmatter.description,
    }
  } catch {
    return undefined
  }
}

function renderProjection(
  persona: CompiledSystemFile | undefined,
  identity: CompiledSystemFile | undefined,
  systemFiles: readonly CompiledSystemFile[],
): string {
  if (!persona && !identity && systemFiles.length === 0) return ""
  const lines = [REMINDER]
  if (persona || identity) {
    lines.push("", "<self>")
    if (persona) {
      lines.push(
        "<projection>$MEMORY_DIR/system/persona.md</projection>",
        persona.body.trimEnd(),
      )
    }
    if (identity) {
      lines.push(
        "<projection>$MEMORY_DIR/system/identity.md</projection>",
        identity.body.trimEnd(),
      )
    }
    lines.push("</self>")
  }
  if (systemFiles.length > 0) {
    lines.push("", "<memory>")
    lines.push(renderSystemTree(systemFiles))
    lines.push("</memory>")
  }
  return lines.join("\n")
}

function renderMetadata(options: CompileMemoryBlockOptions): string {
  return [
    "<memory_metadata>",
    `- AGENT_ID: ${options.agentId}`,
    "</memory_metadata>",
  ].join("\n")
}
