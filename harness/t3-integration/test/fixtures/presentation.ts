  for (const family of ["grok", "gpt", "claude"]) {
    for (const responseStreamingMode of ["token", "paragraph"] as const) {
      it(`${family}/${responseStreamingMode}: reasoning cannot finalize prose; commentary folds after settle`, async () => {
        const harness = await createHarness({ serverSettings: { responseStreamingMode } });
        const events: any[] = [];
        let sequence = 0;
        const projection = new EventProjection({
          threadId: "thread-1", sessionId: family, instanceId: "codex",
          emit: (event: any) => events.push({
            ...event,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString(),
          }),
        });
        const flush = () => harness.emitAndDrain(events.splice(0));
        const read = async () => (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
        const webRows = (thread: any, expanded = false) => deriveMessagesTimelineRows({
          timelineEntries: deriveTimelineEntries(thread.messages, [], deriveWorkLogEntries(thread.activities)),
          isWorking: thread.latestTurn?.state === "running",
          activeTurnStartedAt: thread.latestTurn?.state === "running" ? thread.latestTurn.startedAt : null,
          latestTurn: thread.latestTurn,
          runningTurnId: thread.session?.activeTurnId,
          expandedTurnIds: expanded ? new Set(["turn-1" as never]) : new Set(),
          turnDiffSummaries: [], supportsConversationRollback: false,
        });
        const mobileRows = (thread: any, expanded = false) => deriveThreadFeedPresentation(
          buildThreadFeed(thread), thread.latestTurn,
          expanded ? new Set(["turn-1" as never]) : new Set(),
        );
        const prose = (rows: any[]) => rows.filter(r => r.kind === "message" || r.type === "message")
          .map(r => r.message?.text ?? r.text ?? "").join("\n");
        const intermediate = `${family}: checking the workspace`;
        const first = {
          role: "assistant", timestamp: 100, model: family, stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: `${family} PRIVATE THOUGHT before tool` },
            { type: "text", text: intermediate },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
          ],
        };
        projection.begin("turn-1");
        projection.message(first, false);
        projection.message(first, true);
        projection.project({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1", args: { command: "pwd" } });
        await flush();
        let thread = await read();
        expect(prose(webRows(thread))).toContain(intermediate);
        expect(prose(mobileRows(thread))).toContain(intermediate);
        // The pinned T3 now persists thoughts as dedicated reasoning messages.
        // Guard answer separation, not the obsolete assumption that thoughts
        // are dropped from storage entirely.
        expect(thread.messages.filter(m => m.role !== "reasoning")
          .every(m => !m.text.includes("PRIVATE THOUGHT"))).toBe(true);
        expect(thread.messages.filter(m => m.role === "reasoning").map(m => m.text))
          .toEqual([`${family} PRIVATE THOUGHT before tool`]);

        projection.project({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", result: { content: [{ type: "text", text: "/workspace" }] }, isError: false });
        const final = {
          role: "assistant", timestamp: 200, model: family,
          content: [
            { type: "thinking", thinking: `${family} PRIVATE THOUGHT final` },
            { type: "text", text: `${family}: final beginning\n\n` },
          ],
        };
        // Providers may end reasoning before text, alongside it, or only at
        // message_end. None of those endings may close the answer segment.
        if (family === "claude") projection.endReasoning(final);
        projection.message(final, false);
        if (family === "gpt") projection.endReasoning(final);
        await flush();
        final.content[1].text += "final middle\n\nfinal end";
        projection.message({ ...final, stopReason: "stop" }, true);
        await flush();
        thread = await read();
        const answer = final.content[1].text;
        expect(thread.messages.filter(m => m.role === "assistant").map(m => m.text))
          .toEqual([intermediate, answer]);
        expect(thread.messages.filter(m => m.role === "reasoning").map(m => m.text))
          .toEqual([`${family} PRIVATE THOUGHT before tool`, `${family} PRIVATE THOUGHT final`]);
        expect(webRows(thread).some(r => r.kind === "turn-fold")).toBe(false);
        projection.settle();
        await flush();
        thread = await read();
        for (const rows of [webRows(thread), mobileRows(thread)]) {
          expect(prose(rows)).not.toContain(intermediate);
          expect(prose(rows)).toContain(answer);
          expect(prose(rows)).not.toContain("PRIVATE THOUGHT");
        }
        expect(prose(webRows(thread, true))).toContain(intermediate);
        expect(prose(mobileRows(thread, true))).toContain(intermediate);

        // A fresh query and JSON round trip exercise what reload actually gets,
        // independent of live client object identity or stream caches.
        const reloaded = JSON.parse(JSON.stringify(await read()));
        expect(prose(webRows(reloaded))).toBe(prose(webRows(thread)));
        expect(prose(mobileRows(reloaded))).toBe(prose(mobileRows(thread)));

        // Some providers split a final answer across adjacent assistant items.
        const lastAnswer = reloaded.messages.findLast(m => m.role === "assistant")!;
        // Keep this synthetic segment adjacent to the answer, before any
        // separately stored reasoning item that follows it in the event order.
        const tail = { ...lastAnswer, id: "answer-tail", text: "final appendix",
          createdAt: new Date(Date.parse(lastAnswer.createdAt) + 1).toISOString() };
        reloaded.messages.push(tail);
        for (const rows of [webRows(reloaded), mobileRows(reloaded)]) {
          expect(prose(rows)).toContain(answer);
          expect(prose(rows)).toContain("final appendix");
          expect(prose(rows)).not.toContain(intermediate);
        }
        // Legacy bad projections remain stored, but must not leak even when
        // expanding work. Only our exact reasoning IDs are excluded.
        reloaded.messages.push({ ...tail,
          id: "assistant:pi:legacy:0123456789abcdef01234567:reasoning",
          text: "PRIVATE THOUGHT from old projection" });
        for (const rows of [webRows(reloaded, true), mobileRows(reloaded, true)]) {
          expect(prose(rows)).not.toContain("PRIVATE THOUGHT");
          expect(prose(rows)).toContain("final appendix");
        }
        for (const id of [
          "assistant:pi:legacy:0123456789abcdef01234567",
          "assistant:pi:legacy:zzz:reasoning",
          "assistant:other:legacy:0123456789abcdef01234567:reasoning",
        ]) {
          reloaded.messages.push({ ...tail, id, text: `ordinary answer ${id}` });
        }
        for (const rows of [webRows(reloaded, true), mobileRows(reloaded, true)]) {
          expect(prose(rows)).toContain("ordinary answer assistant:pi:legacy:0123456789abcdef01234567");
          expect(prose(rows)).toContain("ordinary answer assistant:pi:legacy:zzz:reasoning");
          expect(prose(rows)).toContain("ordinary answer assistant:other:legacy:0123456789abcdef01234567:reasoning");
        }
      });
    }
  }

  it("notes and summary transitions keep distinct labels through ingestion, reload and GUI rows", async () => {
    const harness = await createHarness();
    const events: any[] = [];
    let sequence = 0;
    const projection = new EventProjection({
      threadId: "thread-1", sessionId: "notes-label", instanceId: "codex",
      emit: (event: any) => events.push({
        ...event, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString(),
      }),
    });
    projection.begin("turn-1");
    projection.project({ type: "compaction_end", reason: "extension", aborted: false,
      result: { details: { source: "rubato-history-notes-v1", window: { windowId: "window-2" } } } });
    projection.project({ type: "compaction_end", reason: "manual", aborted: false,
      result: { summary: "Actual summary" } });
    projection.project({ type: "compaction_end", aborted: true });
    projection.project({ type: "compaction_end", errorMessage: "storage failed" });
    projection.settle();
    await harness.emitAndDrain(events);
    const thread = JSON.parse(JSON.stringify((await harness.readModel()).threads.find(t => t.id === "thread-1")!));
    expect(thread.activities.filter((a: any) => a.kind === "context-compaction").map((a: any) => a.summary))
      .toEqual(["Context Optimized", "Context compacted"]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(thread.messages, [], deriveWorkLogEntries(thread.activities)),
      isWorking: false, activeTurnStartedAt: null, latestTurn: thread.latestTurn,
      runningTurnId: null, expandedTurnIds: new Set(), turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.filter(r => r.kind === "context-compaction").map(r => r.label))
      .toEqual(["Context Optimized", "Context compacted"]);
  });

  it("a retry chain is one updating work row; only the exhausted chain leaves an error answer", async () => {
    const harness = await createHarness();
    const events: any[] = [];
    let sequence = 0;
    const projection = new EventProjection({
      threadId: "thread-1", sessionId: "retry", instanceId: "codex",
      emit: (event: any) => events.push({
        ...event, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString(),
      }),
    });
    const failed = (timestamp: number, errorMessage: string) => ({ role: "assistant", timestamp,
      model: "claude-opus-5-5", stopReason: "error", errorMessage, content: [] });
    const retry = (message: any, attempt: number) => {
      projection.message(message, true);
      projection.project({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 1000,
        errorMessage: message.errorMessage });
    };
    const read = async () => JSON.parse(JSON.stringify(
      (await harness.readModel()).threads.find(t => t.id === "thread-1")!));
    const warnings = (thread: any) => deriveWorkLogEntries(thread.activities)
      .filter((entry: any) => entry.tone === "info").map((entry: any) => entry.label);
    const answers = (thread: any) => thread.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.text);

    projection.begin("turn-1");
    retry(failed(1, "Connection error."), 1);
    await harness.emitAndDrain(events.splice(0));
    expect(warnings(await read())).toEqual(["Retrying (1/3): Connection error."]);
    retry(failed(2, "Request timed out."), 2);
    projection.message({ role: "assistant", timestamp: 3, model: "claude-opus-5-5", stopReason: "stop",
      content: [{ type: "text", text: "recovered answer" }] }, true);
    projection.project({ type: "auto_retry_end", success: true, attempt: 2 });
    projection.settle();
    await harness.emitAndDrain(events.splice(0));
    let thread = await read();
    expect(answers(thread)).toEqual(["recovered answer"]);
    expect(warnings(thread)).toEqual(["Recovered after 2 retries: Request timed out."]);
    expect(thread.latestTurn.state).toBe("completed");

    projection.begin("turn-2");
    retry(failed(4, "Connection error."), 1);
    projection.message(failed(5, "Connection error."), true);
    projection.project({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Connection error." });
    projection.settle();
    await harness.emitAndDrain(events.splice(0));
    thread = await read();
    expect(answers(thread)).toEqual(["recovered answer", "Connection error."]);
    expect(warnings(thread)).toEqual(["Recovered after 2 retries: Request timed out.", "Failed after 1 retry: Connection error."]);
    expect(thread.activities.filter((a: any) => a.kind === "runtime.error").map((a: any) => a.payload.message))
      .toEqual(["Connection error."]);
    expect(thread.latestTurn.state).toBe("error");
  });

  // Optional private, local-only recording replay. Never put real user
  // transcripts or provider credentials into this repository.
  if (process.env.T3_REPLAY_MESSAGES) {
    const recordings = JSON.parse(NodeFS.readFileSync(process.env.T3_REPLAY_MESSAGES, "utf8"));
    for (const [family, messages] of Object.entries(recordings) as [string, any[]][]) {
      it(`recorded ${family}: exact assistant text survives ingestion and reload`, async () => {
        const harness = await createHarness();
        const events: any[] = [];
        let sequence = 0;
        const projection = new EventProjection({
          threadId: "thread-1", sessionId: family, instanceId: "codex",
          emit: (event: any) => events.push({ ...event,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString() }),
        });
        projection.begin("recorded-turn");
        for (const message of messages) {
          projection.message(message, false);
          projection.message(message, true);
          for (const call of message.content.filter((b: any) => b.type === "toolCall")) {
            projection.project({ type: "tool_execution_start", toolName: call.name, toolCallId: call.id, args: {} });
            projection.project({ type: "tool_execution_end", toolName: call.name, toolCallId: call.id,
              result: { content: [{ type: "text", text: "recorded tool result omitted" }] }, isError: false });
          }
        }
        projection.settle();
        await harness.emitAndDrain(events);
        const thread = (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
        const expected = messages.map(m => m.content.filter((b: any) => b.type === "text")
          .map((b: any) => b.text).join("")).filter(Boolean);
        expect(thread.messages.filter(m => m.role === "assistant" && m.text).map(m => m.text)).toEqual(expected);
        const refreshed = (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
        expect(refreshed.messages).toEqual(thread.messages);
      });
    }
  }

  // Rubato 의 스레드 제목은 T3 의 배경 텍스트 생성이 아니라 Pi 세션이 짓는다.
  // 세션이 이름을 바꾸면 브리지가 그 이름을 thread.metadata.updated 로 내보내고,
  // 인제션이 그것을 스레드 제목으로 앉힌다. 첫 메시지가 제목으로 굳어 있던
  // 스레드에서도 앉아야 한다 — 안 그러면 앱에는 지어진 제목이 영영 안 뜬다.
  it("mirrors a Rubato session title onto a thread that still carries its seed title", async () => {
    const harness = await createHarness({ threadTitle: "루바토 cli쓸때 스레드 제목 지어주는 로직이 있었는데…" });
    const events: any[] = [];
    let sequence = 0;
    const projection = new EventProjection({
      threadId: "thread-1", sessionId: "rubato", instanceId: "rubato",
      emit: (event: any) => events.push({ ...event,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString() }),
    });
    projection.project({ type: "session_info_changed", name: "스레드 제목 배선" });
    await harness.emitAndDrain(events);
    const thread = (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
    expect(thread.title).toBe("스레드 제목 배선");
    expect(thread.titleState?.source).toBe("generated");
  });

  it("keeps a title the user set themselves when the session renames itself", async () => {
    const harness = await createHarness({ threadTitle: "내가 정한 제목" });
    await harness.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-title-manual"),
      threadId: ThreadId.make("thread-1"),
      title: "내가 정한 제목",
    });
    const events: any[] = [];
    let sequence = 0;
    const projection = new EventProjection({
      threadId: "thread-1", sessionId: "rubato", instanceId: "rubato",
      emit: (event: any) => events.push({ ...event,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString() }),
    });
    projection.project({ type: "session_info_changed", name: "Pi 가 지은 제목" });
    await harness.emitAndDrain(events);
    const thread = (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
    expect(thread.title).toBe("내가 정한 제목");
  });

  // 자기 제목을 스스로 짓는 제공자(Codex·OpenCode)는 T3 의 생성이 이기게 둔다.
  // 위 완화가 그쪽까지 열리면 배경 생성이 만든 제목을 제공자 이름이 덮는다.
  it("still refuses a provider title for providers that generate their own", async () => {
    const harness = await createHarness({ threadTitle: "첫 메시지 그대로" });
    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-codex-title"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      payload: { name: "Codex 가 지은 제목" },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads.find(t => t.id === "thread-1")!;
    expect(thread.title).toBe("첫 메시지 그대로");
  });
