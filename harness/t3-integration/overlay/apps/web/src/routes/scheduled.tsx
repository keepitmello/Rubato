import { createFileRoute, redirect } from "@tanstack/react-router";

import { RubatoStandalonePage } from "../components/RubatoStandalonePage";
import { RubatoScheduleSettingsPanel } from "../components/settings/RubatoScheduleSettings";

function ScheduledPage() {
  return (
    <RubatoStandalonePage title="Scheduled Tasks">
      <RubatoScheduleSettingsPanel />
    </RubatoStandalonePage>
  );
}

export const Route = createFileRoute("/scheduled")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ScheduledPage,
});
