import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Rubato's Settings layout (settings-layout-edits.mjs).
function SettingsAdvancedRoute() {
  return <RubatoSettingsPage path="/settings/advanced" />;
}

export const Route = createFileRoute("/settings/advanced")({
  component: SettingsAdvancedRoute,
});
