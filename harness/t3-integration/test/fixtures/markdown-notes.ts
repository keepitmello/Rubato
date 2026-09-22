  it.effect("Rubato markdown notes: create, reject duplicates, autosave and reopen through RPC", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rubato-note-rpc-" });
      yield* buildAppUnderTest();
      const url = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(withWsRpcClient(url, (client) => Effect.gen(function* () {
        const input = { cwd: root, relativePath: "notes/idea.md", contents: "# Idea\n\n" };
        const created = yield* client[WS_METHODS.projectsCreateFile](input);
        assert.equal(created.relativePath, input.relativePath);
        const duplicate = yield* client[WS_METHODS.projectsCreateFile]({
          ...input, contents: "must not overwrite",
        }).pipe(Effect.result);
        assert.equal(duplicate._tag, "Failure");
        if (duplicate._tag === "Failure") assert.include(duplicate.failure.message, "already exists");
        const original = yield* client[WS_METHODS.projectsReadFile](input);
        assert.equal(original.contents, input.contents);
        const contents = "# Idea\n\n작성 후 자동 저장된 메모야.\n";
        yield* client[WS_METHODS.projectsWriteFile]({ ...input, contents });
        const reopened = yield* client[WS_METHODS.projectsReadFile](input);
        assert.equal(reopened.contents, contents);
        const escaped = yield* client[WS_METHODS.projectsCreateFile]({
          ...input, relativePath: "../escape.md",
        }).pipe(Effect.result);
        assert.equal(escaped._tag, "Failure");
      })));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
