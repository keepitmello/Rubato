import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Rubato's Settings layout (settings-layout-edits.mjs).
function SettingsAgentsRoute() {
  return <RubatoSettingsPage path="/settings/agents" />;
}

export const Route = createFileRoute("/settings/agents")({
  component: SettingsAgentsRoute,
});
