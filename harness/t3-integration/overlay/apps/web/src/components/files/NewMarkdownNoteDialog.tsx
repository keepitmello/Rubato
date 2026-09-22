import type { ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useId, useRef, useState } from "react";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "../ui/dialog";
import { confirmProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

export interface MarkdownNoteTarget {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}

export function normalizeMarkdownNotePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (
    !path || path.startsWith("/") || /[<>:"|?*\u0000-\u001f]/.test(path) ||
    path.split("/").some((part) => !part.trim() || part === "." || part === "..")
  ) {
    throw new Error("Enter a file path inside this repository, such as notes/idea.md.");
  }
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

export function MarkdownNoteDialog({
  repository,
  onClose,
  onCreate,
}: {
  repository: string;
  onClose: () => void;
  onCreate: (relativePath: string, contents: string) => Promise<void>;
}) {
  const [path, setPath] = useState("notes/new-note.md");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const errorId = useId();
  const submit = async () => {
    if (inFlight.current) return;
    let relativePath: string;
    try { relativePath = normalizeMarkdownNotePath(path); }
    catch (cause) { setError((cause as Error).message); return; }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const title = relativePath.split("/").at(-1)!.replace(/\.md$/i, "");
      await onCreate(relativePath, `# ${title}\n\n`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the note. Try again.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
      <DialogPopup className="max-w-md" showCloseButton={!saving}>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>New Markdown note</DialogTitle>
            <DialogDescription>Create a file, then write with automatic saving.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <p className="truncate text-xs text-muted-foreground" title={repository}>
              Repository: {repository.split(/[\\/]/).filter(Boolean).at(-1)}
            </p>
            <label className="grid gap-2 text-sm">
              File path
              <Input
                autoFocus
                value={path}
                disabled={saving}
                onChange={(event) => { setPath(event.target.value); setError(null); }}
                aria-invalid={error !== null}
                aria-describedby={error ? errorId : undefined}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Relative to the repository. Missing folders will be created.
            </p>
            {error ? <p id={errorId} role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !path.trim()}>{saving ? "Creating…" : "Create note"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function NewMarkdownNoteDialog({ target, onClose }: {
  target: MarkdownNoteTarget;
  onClose: () => void;
}) {
  const createFile = useAtomCommand(projectEnvironment.createFile, { reportFailure: false });
  return (
    <MarkdownNoteDialog
      repository={target.cwd}
      onClose={onClose}
      onCreate={async (relativePath, contents) => {
        const { environmentId } = target.threadRef;
        const result = await createFile({ environmentId, input: { cwd: target.cwd, relativePath, contents } });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        const savedPath = result.value.relativePath;
        setProjectFileQueryData(environmentId, target.cwd, savedPath, contents);
        confirmProjectFileQueryData(environmentId, target.cwd, savedPath, contents);
        // A line reveal explicitly opens source, without changing reading defaults.
        useRightPanelStore.getState().openFile(target.threadRef, savedPath, 1);
      }}
    />
  );
}
