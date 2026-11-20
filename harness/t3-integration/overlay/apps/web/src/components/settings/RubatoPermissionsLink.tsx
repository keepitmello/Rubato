// Settings > General > macOS permissions: the link to the permissions page
// (RubatoPermissionsSettings.tsx), which has no entry of its own in the
// settings sidebar (settings-layout-edits.mjs).
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function RubatoPermissionsLinkSection() {
  const navigate = useNavigate();
  return (
    <SettingsSection id="rubato-permissions-link" title="macOS permissions">
      <SettingsRow
        title="macOS permissions"
        description="Screen recording, accessibility and automation for the commands sessions run."
        control={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/settings/permissions" })}>
            Open
          </Button>
        }
      />
    </SettingsSection>
  );
}
