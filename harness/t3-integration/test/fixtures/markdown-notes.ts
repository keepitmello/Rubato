  it.effect("Rubato markdown notes: create, reject duplicates, autosave and reopen", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const cwd = yield* makeTempDir;
      const input = { cwd, relativePath: "notes/idea.md", contents: "# Idea\n\n" };
      const created = yield* workspaceFileSystem.writeFile({ ...input, createOnly: true });
      expect(created.relativePath).toBe(input.relativePath);
      const duplicate = yield* workspaceFileSystem
        .writeFile({ ...input, contents: "must not overwrite", createOnly: true })
        .pipe(Effect.result);
      expect(duplicate._tag).toBe("Failure");
      if (duplicate._tag === "Failure") {
        const cause = (duplicate.failure as { cause?: unknown }).cause;
        expect(cause instanceof Error ? cause.message : "").toContain("already exists");
      }
      const original = yield* workspaceFileSystem.readFile(input);
      expect(original.contents).toBe(input.contents);
      const contents = "# Idea\n\n작성 후 자동 저장된 메모야.\n";
      yield* workspaceFileSystem.writeFile({ ...input, contents });
      const reopened = yield* workspaceFileSystem.readFile(input);
      expect(reopened.contents).toBe(contents);
      const escaped = yield* workspaceFileSystem
        .writeFile({ ...input, relativePath: "../escape.md", createOnly: true })
        .pipe(Effect.result);
      expect(escaped._tag).toBe("Failure");
    }).pipe(Effect.provide(layerTest)),
  );

