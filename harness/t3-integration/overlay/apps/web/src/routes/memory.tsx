import { createFileRoute, redirect } from "@tanstack/react-router";

import { RubatoStandalonePage } from "../components/RubatoStandalonePage";
import { RubatoMemoryPage } from "../components/settings/RubatoMemoryPage";
import { memorySearch } from "../components/settings/RubatoMemoryPage.logic";

function MemoryPage() {
  return (
    <RubatoStandalonePage title="Memory">
      <RubatoMemoryPage />
    </RubatoStandalonePage>
  );
}

export const Route = createFileRoute("/memory")({
  validateSearch: memorySearch,
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
