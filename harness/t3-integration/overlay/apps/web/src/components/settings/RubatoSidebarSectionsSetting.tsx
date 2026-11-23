// Rubato (sidebar-blocks-edits.mjs): Settings > General > Sidebar:
// how many threads Recent shows, and putting the sidebar's sections back in
// their first order. The order itself is set by dragging a section's header in
// the sidebar (sidebar/RubatoSidebarBlockDrag.tsx). Both are device settings.
import { T } from "gt-react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  RECENT_LIMIT_MAX,
  RECENT_LIMIT_MIN,
  clampRecentLimit,
  isDefaultSidebarBlockOrder,
  resolveSidebarBlockOrder,
} from "../sidebar/rubatoSidebarBlocks";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { searchableSetting, useSearchableSetting } from "./settingsSearch";

export function RubatoSidebarSectionsSettingsRows() {
  const setting = useSearchableSetting()("rubato-show-companion-leads");
  const showCompanionLeads = useClientSettings((settings) => settings.rubatoShowCompanionLeads);
  const recentLimit = useClientSettings((settings) => settings.rubatoRecentLimit);
  const stored = useClientSettings((settings) => settings.rubatoSidebarBlocks);
  const isDefaultOrder = isDefaultSidebarBlockOrder(resolveSidebarBlockOrder(stored));
  return (
    <>
      <SettingsRow
        {...setting}
        description={<T>When hidden, you can still open them from a companion chat. Notifications are separate.</T>}
        control={
          <Switch
            aria-label={setting.title}
            checked={showCompanionLeads}
            onCheckedChange={(value) => void updateClientSettings({ rubatoShowCompanionLeads: value })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("rubato-recent-limit")}
        description="How many threads from all projects Recent shows while the sidebar is narrowed to one project."
        control={
          <NumberField
            value={clampRecentLimit(recentLimit)}
            min={RECENT_LIMIT_MIN}
            max={RECENT_LIMIT_MAX}
            step={1}
            size="sm"
            className="w-28"
            onValueChange={(value) => {
              if (value === null) return;
              const next = clampRecentLimit(value);
              if (next !== recentLimit) void updateClientSettings({ rubatoRecentLimit: next });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement />
              <NumberFieldInput aria-label="Threads in Recent" />
              <NumberFieldIncrement />
            </NumberFieldGroup>
          </NumberField>
        }
      />
      <SettingsRow
        {...searchableSetting("rubato-sidebar-blocks")}
        description="Drag a section's header in the sidebar to move it: Recent, the project's threads, Working, Snoozed or Settled."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={isDefaultOrder}
            onClick={() => void updateClientSettings({ rubatoSidebarBlocks: [] })}
          >
            Reset
          </Button>
        }
      />
    </>
  );
}
