import { createFileRoute, redirect } from "@tanstack/react-router";

import { RubatoStandalonePage } from "../components/RubatoStandalonePage";
import { RubatoMemorySettingsPanel } from "../components/settings/RubatoMemorySettings";

function MemoryPage() {
  return (
    <RubatoStandalonePage title="Memory">
      <RubatoMemorySettingsPanel />
    </RubatoStandalonePage>
  );
}

export const Route = createFileRoute("/memory")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: MemoryPage,
});
