// Rubato (project-rail-edits.mjs): Settings > Threads & Projects > the project
// row on the new-thread screen (chat/RubatoHomeProjects.tsx). Off by default.
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function RubatoHomeProjectsSettingsRow() {
  const enabled = useClientSettings((settings) => settings.rubatoHomeProjects);
  const updateClientSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("rubato-home-projects")}
      description="Show project tabs and the selected project's newest threads below the composer when you start a new thread."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ rubatoHomeProjects: Boolean(checked) })
          }
          aria-label="Projects on the new-thread screen"
        />
      }
    />
  );
}
