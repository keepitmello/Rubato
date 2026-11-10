import { createFileRoute, redirect } from "@tanstack/react-router";

import { RubatoStandalonePage } from "../components/RubatoStandalonePage";
import { RubatoStatusBoardPanel } from "../components/RubatoStatusBoardPage";

function StatusBoardPage() {
  return (
    <RubatoStandalonePage title="Status board">
      <RubatoStatusBoardPanel />
    </RubatoStandalonePage>
  );
}

export const Route = createFileRoute("/board")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: StatusBoardPage,
});
