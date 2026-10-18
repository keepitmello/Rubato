// Rubato (sidebar-blocks-edits.mjs): Settings > Threads & Projects > Sidebar:
// how many threads Recent shows, and putting the sidebar's sections back in
// their first order. The order itself is set by dragging a section's header in
// the sidebar (sidebar/RubatoSidebarBlockDrag.tsx). Both are device settings.
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
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
import { searchableSetting } from "./settingsSearch";

export function RubatoSidebarSectionsSettingsRows() {
  const recentLimit = useClientSettings((settings) => settings.rubatoRecentLimit);
  const stored = useClientSettings((settings) => settings.rubatoSidebarBlocks);
  const updateClientSettings = useUpdateClientSettings();
  const isDefaultOrder = isDefaultSidebarBlockOrder(resolveSidebarBlockOrder(stored));
  return (
    <>
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
