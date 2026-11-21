import { createFileRoute } from "@tanstack/react-router";

import { RubatoCompanionSettingsPanel } from "../components/settings/RubatoCompanionSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

// Settings › Companion (companion-edits.mjs).
function SettingsCompanionRoute() {
  return (
    <SettingsPageContainer width="wide">
      <RubatoCompanionSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/companion")({
  component: SettingsCompanionRoute,
});
