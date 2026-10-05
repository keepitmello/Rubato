  for (const status of ["completed", "failed"] as const) {
    it(`${status}: preserves a long report through ingestion and a new panel fold`, async () => {
      const harness = await createHarness();
      const events: any[] = [];
      let sequence = 0;
      const projection = new EventProjection({
        threadId: "thread-1", sessionId: "agent-report", instanceId: "codex",
        emit: (event: any) => events.push({
          ...event,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString(),
        }),
      });
      const report = "# 검증 결과\n\n" + "완료한 작업과 검증 근거를 남겨. ".repeat(800)
        + "\n\n```ts\nconst complete = true;\n```\n\n마지막 문장까지 보존됐어.";
      projection.begin("turn-1");
      projection.project({
        type: "tool_execution_end", toolName: "Agent", toolCallId: "spawn-report",
        result: { details: { agentId: "st_report", status: "running", task_summary: "Read the report" } },
      });
      if (status === "completed") {
        projection.project({
          type: "extension_event", name: "rubato.task.updated",
          data: { tasks: [{ task_id: "st_report", status, final_response: report }] },
        });
      } else {
        projection.completeTask(projection.tasks.get("st_report"), "failed", report);
      }
      await harness.emitAndDrain(events.splice(0));
      const thread = (await harness.readModel()).threads.find((item) => item.id === "thread-1")!;
      const completion = thread.activities.find((activity) =>
        activity.kind === "task.completed" && (activity.payload as any).taskId === "st_report")!;
      expect((completion.payload as any).summary.length).toBeLessThanOrEqual(180);
      expect((completion.payload as any).detail).toBe(report);
      // A new fold, not the producer's in-memory task cache, is what a reload reads.
      const agent = foldSubagentActivities(thread.activities).find((item) => item.id === "st_report")!;
      expect(status === "completed" ? agent.result : agent.error).toBe(report);
      if (status === "completed") {
        // AgentSend revives the same id: the reload shows it working, as run 2.
        projection.project({ type: "extension_event", name: "rubato.task.updated",
          data: { tasks: [{ task_id: "st_report", status: "running" }] } });
        await harness.emitAndDrain(events.splice(0));
        const revived = foldSubagentActivities((await harness.readModel()).threads
          .find((item) => item.id === "thread-1")!.activities).find((item) => item.id === "st_report")!;
        expect(revived.status).toBe("running");
        expect(revived.activationCount).toBe(2);
      }
    });
  }

  it("a taskforce keeps its board, member labels, model names and turns through ingestion and reload", async () => {
    const harness = await createHarness();
    const events: any[] = [];
    let sequence = 0;
    const projection = new EventProjection({
      threadId: "thread-1", sessionId: "agent-board", instanceId: "codex",
      emit: (event: any) => events.push({
        ...event,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)).toISOString(),
      }),
    });
    const summary = "Refactor the token refresh path so expired sessions renew without a reload";
    const board = (status: string) => ({
      type: "extension_event", name: "rubato.team.board.updated",
      data: { parent_session_id: "agent-board", teams: [{ team_run_id: "run_auth", team_name: "auth-refactor", tasks: [
        { id: "1", subject: "Refresh path", description: "Rewrite refresh.\nKeep the API.", status, owner: "owner",
          blocked_by: [], updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "2", subject: "Verify refresh", description: "", status: "pending", blocked_by: ["1"],
          updated_at: "2026-01-01T00:00:00.000Z" },
      ] }] },
    });
    projection.begin("turn-1");
    projection.project({ type: "tool_execution_start", toolName: "team_create", toolCallId: "call_team",
      args: { team_name: "auth-refactor" } });
    // The runtime can report the board before team_create returns its run id.
    projection.project(board("pending"));
    projection.project({ type: "tool_execution_end", toolName: "team_create", toolCallId: "call_team", isError: false,
      result: { details: { kind: "created", team_name: "auth-refactor", team_run_id: "run_auth", members: [
        { name: "owner", task_id: "st_owner", role: "owner", model: "anthropic/claude-opus-5-5", effort: "high",
          task_summary: summary },
      ] } } });
    projection.project({ type: "extension_event", name: "rubato.task.updated", data: { tasks: [{
      task_id: "st_owner", status: "running",
      live_progress: { last_assistant_line: "Running the suite.", turns: 7, total_tokens: 1200 },
      run_stats: { speed_index: 150 },
    }] } });
    projection.project(board("in_progress"));
    projection.project(board("in_progress"));
    await harness.emitAndDrain(events.splice(0));
    let thread = (await harness.readModel()).threads.find((item) => item.id === "thread-1")!;
    let agents = foldSubagentActivities(thread.activities);
    let team = agents.find((item) => item.id === "call_team")!;
    const owner = agents.find((item) => item.id === "st_owner")!;
    expect(team.board?.tasks.map((task) => [task.id, task.status, task.owner])).toEqual([
      ["1", "in_progress", "owner"], ["2", "pending", null],
    ]);
    expect(team.board?.tasks[0]?.description).toBe("Rewrite refresh.\nKeep the API.");
    expect(team.board?.tasks[1]?.blockedBy).toEqual(["1"]);
    expect(team.progress).toBeNull();
    expect(owner.label).toBe(summary);
    expect(owner.title.startsWith("opus-5-5 · high · ")).toBe(true);
    expect(owner.modelLabel).toBe("Opus 5.5 · High");
    expect(owner.usage?.turns).toBe(7);
    expect(owner.role).toBe("owner");
    expect(owner.memberName).toBe("owner");
    // A member resting between turns reloads as waiting, not done.
    projection.project({ type: "extension_event", name: "rubato.task.updated", data: { tasks: [{
      task_id: "st_owner", status: "completed", residency_state: "resident", final_response: "Waiting on the build." }] } });
    await harness.emitAndDrain(events.splice(0));
    thread = (await harness.readModel()).threads.find((item) => item.id === "thread-1")!;
    agents = foldSubagentActivities(thread.activities);
    expect(agents.find((item) => item.id === "st_owner")?.status).toBe("idle");
    expect(agents.find((item) => item.id === "st_owner")?.progress).toBe("Waiting on the build.");
    // A team whose members all rest waits too: nothing runs, so no background work shows.
    expect(agents.find((item) => item.id === "call_team")?.status).toBe("idle");
    // A board change after the team settled must not reopen it.
    projection.project({ type: "extension_event", name: "rubato.task.updated", data: { tasks: [{
      task_id: "st_owner", status: "completed", final_response: "Done." }] } });
    projection.project(board("completed"));
    await harness.emitAndDrain(events.splice(0));
    thread = (await harness.readModel()).threads.find((item) => item.id === "thread-1")!;
    agents = foldSubagentActivities(thread.activities);
    team = agents.find((item) => item.id === "call_team")!;
    expect(team.status).toBe("completed");
    expect(team.board?.tasks[0]?.status).toBe("completed");
  });
