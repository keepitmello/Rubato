import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { GitDiffResponse, GitStatusResponse } from "@rubato/remote-protocol"

const run = promisify(execFile)

export async function readGitStatus(cwd: string): Promise<GitStatusResponse> {
  const stdout = await git(cwd, ["status", "--porcelain", "-uall"])
  const files = stdout.split("\n").flatMap((line) => {
    if (!line) return []
    const status = line.slice(0, 2).trim() || "?"
    let path = line.slice(3)
    const renamed = path.indexOf(" -> ")
    if (renamed >= 0) path = path.slice(renamed + 4)
    return [{ path, status }]
  })
  return { files }
}

export async function readGitDiff(cwd: string): Promise<GitDiffResponse> {
  let stdout = await git(cwd, ["diff", "HEAD", "--no-color"]).catch(() => git(cwd, ["diff", "--no-color"]))
  stdout = stdout ?? ""
  const hunks = stdout.split(/(?=^@@)/m).filter((part) => part.startsWith("@@"))
  const files = new Set(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("diff --git "))
      .map((line) => line.slice("diff --git ".length)),
  )
  return {
    diff: {
      oldFile: { fileName: "a", fileLang: "", content: "" },
      newFile: { fileName: "b", fileLang: "", content: stdout },
      hunks: hunks.length > 0 ? hunks : stdout ? [stdout] : [],
    },
    summary: files.size > 0 ? `${files.size}개 파일 변경` : "바뀐 파일이 없어요.",
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 12_000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number }
    if (typeof err.stdout === "string" && err.stdout) return err.stdout
    if (String(err.stderr ?? "").includes("not a git repository")) return ""
    throw error
  }
}
