import { createFileRoute } from "@tanstack/react-router";

import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";

// Rubato's Settings layout (settings-layout-edits.mjs).
function SettingsChatRoute() {
  return <RubatoSettingsPage path="/settings/chat" />;
}

export const Route = createFileRoute("/settings/chat")({
  component: SettingsChatRoute,
});
