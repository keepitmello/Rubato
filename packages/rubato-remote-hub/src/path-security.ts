import { realpath, stat } from "node:fs/promises"
import { isPathInside } from "./files.js"

export class AllowedPathResolver {
  readonly #roots: readonly string[]
  #realRoots: readonly string[] | null = null

  constructor(roots: readonly string[]) {
    this.#roots = roots
  }

  async resolve(candidate: string, kind: "file" | "directory" | "either" = "either"): Promise<string> {
    const [path, roots] = await Promise.all([realpath(candidate), this.#resolvedRoots()])
    if (!roots.some((root) => isPathInside(path, root))) throw new Error("path_not_allowed")
    const info = await stat(path)
    if (kind === "file" && !info.isFile()) throw new Error("path_not_allowed")
    if (kind === "directory" && !info.isDirectory()) throw new Error("path_not_allowed")
    return path
  }

  async #resolvedRoots(): Promise<readonly string[]> {
    this.#realRoots ??= await Promise.all(this.#roots.map((root) => realpath(root)))
    return this.#realRoots
  }
}
