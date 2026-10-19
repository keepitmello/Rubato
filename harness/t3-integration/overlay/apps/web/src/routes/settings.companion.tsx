import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Settings › Companion (companion-edits.mjs).
function SettingsCompanionRoute() {
  return <RubatoSettingsPage path="/settings/companion" />;
}

export const Route = createFileRoute("/settings/companion")({
  component: SettingsCompanionRoute,
});
