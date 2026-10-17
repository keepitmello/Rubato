import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Rubato's Settings layout (settings-layout-edits.mjs).
function SettingsThreadsRoute() {
  return <RubatoSettingsPage path="/settings/threads" />;
}

export const Route = createFileRoute("/settings/threads")({
  component: SettingsThreadsRoute,
});
