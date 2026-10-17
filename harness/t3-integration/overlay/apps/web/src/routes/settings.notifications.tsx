import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Rubato's Settings layout (settings-layout-edits.mjs).
function SettingsNotificationsRoute() {
  return <RubatoSettingsPage path="/settings/notifications" />;
}

export const Route = createFileRoute("/settings/notifications")({
  component: SettingsNotificationsRoute,
});
