// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type WorkspaceEntryOperation = "create-directory" | "rename" | "trash";

export interface ManageWorkspaceEntryInput {
  readonly cwd: string;
  readonly operation: WorkspaceEntryOperation;
  readonly relativePath: string;
  /** The new path for a rename. */
  readonly nextRelativePath?: string | undefined;
}

const OUTSIDE = "Choose a path inside this workspace.";

function segmentsOf(relativePath: string): string[] {
  const relative = relativePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const segments = relative.split("/");
  if (
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    segments.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(OUTSIDE);
  }
  return segments;
}

function inside(root: string, absolute: string): boolean {
  return absolute === root || absolute.startsWith(root + path.sep);
}

/** The entry's absolute path. Its parent must exist and resolve inside the root, links included. */
async function resolveEntry(root: string, relativePath: string): Promise<string> {
  const segments = segmentsOf(relativePath);
  const parent = await fs.realpath(path.join(root, ...segments.slice(0, -1)));
  if (!inside(root, parent)) throw new Error(OUTSIDE);
  return path.join(parent, segments.at(-1)!);
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, ...env }, timeout: 60_000 }, (error, _out, stderr) => {
      if (!error) return resolve();
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === "ENOENT"
            ? `Moving to the trash needs '${command}', which this machine does not have.`
            : stderr.trim() || error.message,
        ),
      );
    });
  });
}

const WINDOWS_RECYCLE = [
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "$p = $env:RUBATO_TRASH_PATH",
  "if (Test-Path -LiteralPath $p -PathType Container) {",
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "} else {",
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "}",
].join("\n");

/** Moves the entry to the system trash, so a delete from the explorer can be undone. */
async function moveToTrash(target: string): Promise<void> {
  if (process.platform === "darwin") return run("/usr/bin/trash", [target]);
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECYCLE], {
      RUBATO_TRASH_PATH: target,
    });
  }
  return run("gio", ["trash", "--", target]);
}

/**
 * Folder creation, rename and trash for the file explorer. Never overwrites,
 * never follows a link out of the workspace, never touches the root itself.
 * Returns the workspace-relative path of the result.
 */
export async function manageWorkspaceEntry(
  input: ManageWorkspaceEntryInput,
): Promise<{ relativePath: string }> {
  const root = await fs.realpath(input.cwd);
  const relativePath = segmentsOf(input.relativePath).join("/");

  if (input.operation === "create-directory") {
    let directory = root;
    const segments = relativePath.split("/");
    for (const [index, part] of segments.entries()) {
      directory = path.join(directory, part);
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (index === segments.length - 1) throw new Error(`'${part}' already exists here.`);
      }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Choose a folder in this workspace, not a file or a linked folder.");
      }
    }
    return { relativePath };
  }

  const source = await resolveEntry(root, relativePath);
  const sourceStat = await lstatOrNull(source);
  if (sourceStat === null) throw new Error(`'${relativePath}' no longer exists.`);

  if (input.operation === "trash") {
    await moveToTrash(source);
    return { relativePath };
  }

  if (input.nextRelativePath === undefined) throw new Error("Choose the new name.");
  const nextRelativePath = segmentsOf(input.nextRelativePath).join("/");
  const destination = await resolveEntry(root, nextRelativePath);
  const existing = await lstatOrNull(destination);
  // On a case-insensitive disk a case-only rename finds the source itself.
  if (existing !== null && (existing.ino !== sourceStat.ino || existing.dev !== sourceStat.dev)) {
    throw new Error(`'${path.basename(destination)}' already exists here.`);
  }
  await fs.rename(source, destination);
  return { relativePath: nextRelativePath };
}
