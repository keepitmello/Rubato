// Rubato (window-material-edits.mjs): Settings > Appearance > Sidebar material.
import {
  pickSidebarMaterial,
  type SidebarMaterial,
  sidebarMaterialNeedsRestart,
} from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { windowMaterialState } from "../../rubatoWindowMaterial";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SIDEBAR_MATERIAL_LABELS: Record<SidebarMaterial, string> = {
  opaque: "Opaque",
  vibrancy: "macOS material",
  "liquid-glass": "Liquid Glass",
};

export function SidebarMaterialSettingsRow() {
  const saved = useClientSettings((settings) => settings.sidebarMaterial);
  const updateClientSettings = useUpdateClientSettings();
  const machine = windowMaterialState;
  if (machine === null || machine.available.length < 2) return null;
  const wanted = pickSidebarMaterial(saved, machine);
  const offersLiquidGlass = machine.available.includes("liquid-glass");
  return (
    <SettingsRow
      {...searchableSetting("sidebar-material")}
      description={
        offersLiquidGlass
          ? "Let the desktop show through the sidebar and the right panel's frame. Switching to or from Liquid Glass applies after Rubato restarts."
          : "Let the desktop show through the sidebar and the right panel's frame."
      }
      status={
        sidebarMaterialNeedsRestart(machine.active, wanted) ? (
          <span className="text-warning-foreground">Restart Rubato to apply.</span>
        ) : null
      }
      control={
        <Select
          value={wanted}
          onValueChange={(value) => {
            const next = machine.available.find((material) => material === value);
            if (next !== undefined) void updateClientSettings({ sidebarMaterial: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Sidebar material">
            <SelectValue>{SIDEBAR_MATERIAL_LABELS[wanted]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {machine.available.map((material) => (
              <SelectItem hideIndicator key={material} value={material}>
                {SIDEBAR_MATERIAL_LABELS[material]}
                {material === machine.fallback ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
