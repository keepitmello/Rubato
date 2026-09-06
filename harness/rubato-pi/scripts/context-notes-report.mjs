import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path) { console.error("사용법: node context-notes-report.mjs <문맥기록.sqlite>"); process.exitCode = 1; }
else {
  let db;
  try {
    db = new DatabaseSync(resolve(path), { readOnly: true });
    const events = db.prepare("SELECT ordinal,created_at,event,data FROM diagnostics ORDER BY ordinal").all();
    const counters = {}; const tools = {}; const windows = [];
    for (const event of events) {
      counters[event.event] = (counters[event.event] ?? 0) + 1;
      const data = JSON.parse(event.data);
      if (event.event === "tool_completed" || event.event === "tool_failed") {
        const tool = tools[data.name] ??= { completed: 0, failed: 0, durationMs: 0, outputChars: 0 };
        tool[event.event === "tool_completed" ? "completed" : "failed"]++;
        tool.durationMs += data.duration_ms ?? 0; tool.outputChars += data.output_chars ?? 0;
      }
      if (event.event === "transition_requested" || event.event === "transition_committed") windows.push({ at: event.created_at, event: event.event, ...data });
    }
    // Metadata only. Never dump original conversations or note contents.
    console.log(JSON.stringify({ events: counters, tools, windows }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { db?.close(); }
}
