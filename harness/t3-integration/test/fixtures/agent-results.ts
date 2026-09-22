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
      await harness.emitAndDrain(events);
      const thread = (await harness.readModel()).threads.find((item) => item.id === "thread-1")!;
      const completion = thread.activities.find((activity) =>
        activity.kind === "task.completed" && (activity.payload as any).taskId === "st_report")!;
      expect((completion.payload as any).summary.length).toBeLessThanOrEqual(180);
      expect((completion.payload as any).detail).toBe(report);
      // A new fold, not the producer's in-memory task cache, is what a reload reads.
      const agent = foldSubagentActivities(thread.activities).find((item) => item.id === "st_report")!;
      expect(status === "completed" ? agent.result : agent.error).toBe(report);
    });
  }
