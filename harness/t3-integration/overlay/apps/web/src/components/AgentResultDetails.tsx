import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import ChatMarkdown from "./ChatMarkdown";

/** The retained report and latest activity, not a child conversation viewer. */
export function AgentResultDetails({ agent }: { agent: RuntimeSubagent }) {
  const working = ["pending", "running", "waiting"].includes(agent.status);
  const report = agent.error ?? agent.result;
  const activity = agent.progress;
  return (
    <div className="space-y-3 text-xs">
      {report ? (
        <section>
          <h4 className="mb-2 font-medium text-muted-foreground">
            {agent.error ? "Error" : "Result"}
          </h4>
          <ChatMarkdown
            text={report}
            cwd={undefined}
            className="min-w-0 text-xs [overflow-wrap:anywhere] [&_pre]:max-w-full"
          />
        </section>
      ) : null}
      {activity && activity !== report ? (
        <section>
          <h4 className="mb-1 font-medium text-muted-foreground">
            {working ? "Current activity" : "Last activity"}
          </h4>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{activity}</p>
        </section>
      ) : null}
      {agent.lastToolName ? (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          Last tool: <span className="font-mono">{agent.lastToolName}</span>
        </p>
      ) : null}
      {!report && !activity && !agent.lastToolName ? (
        <p className="text-muted-foreground">
          {working ? "Working. No update yet." : "No result was recorded."}
        </p>
      ) : null}
    </div>
  );
}
