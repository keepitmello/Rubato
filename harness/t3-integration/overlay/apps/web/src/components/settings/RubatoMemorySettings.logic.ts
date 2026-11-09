import type { DreamRunDetail, MemoryStoreSummary } from "../../state/rubatoMemory";

/** Just what matching needs from an app project. */
export interface ProjectLike {
  readonly workspaceRoot: string;
}

/**
 * The app project a store's conversation belongs in: one opened at a folder the store serves, else
 * one opened inside such a folder (the shallowest). A store with no known folder has none.
 */
export function projectForStore<P extends ProjectLike>(
  projects: readonly P[],
  roots: readonly string[] | null,
): P | null {
  if (!roots || roots.length === 0) return null;
  const exact = projects.find((project) => roots.includes(project.workspaceRoot));
  if (exact) return exact;
  const inside = projects.filter((project) =>
    roots.some((root) => project.workspaceRoot.startsWith(`${root}/`)),
  );
  return inside.toSorted((a, b) => a.workspaceRoot.length - b.workspaceRoot.length)[0] ?? null;
}

/**
 * What a new thread about a memory starts with: where it is, the file or dream run asked about, and
 * how to change it. The question itself is left for the user to type.
 */
export function chatPrompt(
  store: Pick<MemoryStoreSummary, "store" | "repo">,
  about: { readonly file?: string; readonly run?: Pick<DreamRunDetail, "runId" | "sources"> } = {},
): string {
  const lines = [`About the \`${store.store}\` memory (\`${store.repo}\`). Change it with the memory tools, so every edit is committed with its reason.`];
  if (about.file) lines.push(`- The file: \`${about.file}\``);
  if (about.run) {
    lines.push(`- The dream run \`${about.run.runId}\``);
    if (about.run.sources.report) lines.push(`- Its report: ${about.run.sources.report}`);
    if (about.run.sources.range)
      lines.push(`- What it changed: \`git -C ${store.repo} diff ${about.run.sources.range.base} ${about.run.sources.range.head}\``);
  }
  return `${lines.join("\n")}\n\n`;
}

/** The text of a file a diff adds, front matter left out. */
export function addedContent(diff: string): string {
  const rows = diff.split("\n");
  const start = rows.findIndex((row) => row.startsWith("@@"));
  if (start === -1) return "";
  const text = rows
    .slice(start + 1)
    .filter((row) => row.startsWith("+"))
    .map((row) => row.slice(1))
    .join("\n");
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export type BadgeVariant = "success" | "warning" | "error" | "info" | "secondary" | "outline";
