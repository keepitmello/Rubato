import { createFileRoute, redirect } from "@tanstack/react-router";

import { RubatoStandalonePage } from "../components/RubatoStandalonePage";
import { RubatoStatsPanel } from "../components/RubatoStatsPage";

function StatsPage() {
  return (
    <RubatoStandalonePage title="Stats">
      <RubatoStatsPanel />
    </RubatoStandalonePage>
  );
}

export const Route = createFileRoute("/stats")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: StatsPage,
});
