// The block a T3 settings panel is drawn into on a Rubato page
// (rubatoSettingsLayout.ts). settingsLayout.tsx asks it whether a row, a
// section or a page container shows (settings-layout-edits.mjs). Outside a
// Rubato page there is no block and T3's components behave as they always do.
import { createContext, useContext, type ReactNode } from "react";

import {
  rubatoRowVisible,
  rubatoSectionMode,
  type RubatoSettingsFilter,
} from "./rubatoSettingsLayout";

const RubatoSettingsBlockContext = createContext<RubatoSettingsFilter | null>(null);

export function RubatoSettingsBlockScope({
  value,
  children,
}: {
  value: RubatoSettingsFilter | null;
  children: ReactNode;
}) {
  return <RubatoSettingsBlockContext value={value}>{children}</RubatoSettingsBlockContext>;
}

export function useRubatoSettingsBlock(): RubatoSettingsFilter | null {
  return useContext(RubatoSettingsBlockContext);
}

/** A T3 row: shown when its block picks it; what it contains is drawn as T3 draws it. */
export function RubatoSettingsRowGate({
  id,
  settingKeys,
  children,
}: {
  id: string | undefined;
  settingKeys: readonly string[] | undefined;
  children: ReactNode;
}) {
  const filter = useRubatoSettingsBlock();
  if (filter === null) return children;
  if (!rubatoRowVisible(filter, id, settingKeys ?? [])) return null;
  return <RubatoSettingsBlockScope value={null}>{children}</RubatoSettingsBlockScope>;
}

/**
 * A T3 section: in a block that picks rows its rows join the block's own card;
 * in a block that shows whole panels it keeps its heading, unless the block
 * names other sections.
 */
export function RubatoSettingsSectionGate({
  id,
  children,
  section,
}: {
  id: string | undefined;
  children: ReactNode;
  section: () => ReactNode;
}) {
  const filter = useRubatoSettingsBlock();
  if (filter === null) return section();
  const mode = rubatoSectionMode(filter, id);
  if (mode === "hidden") return null;
  if (mode === "unwrapped") return children;
  return <RubatoSettingsBlockScope value={mode.inner}>{section()}</RubatoSettingsBlockScope>;
}

/**
 * For T3 sections built without SettingsSection (General's folded Legacy
 * features): true where the block would hide or unwrap a section. A fold has no
 * card to give up, so it shows only in a block that names it.
 */
export function useRubatoHidesSection(id: string): boolean {
  const filter = useRubatoSettingsBlock();
  if (filter === null) return false;
  // "hidden" and "unwrapped" are strings; a block that names the section returns its scope.
  return typeof rubatoSectionMode(filter, id) === "string";
}

/** A T3 page inside a Rubato page gives up its scroll area, scope sentence and width. */
export function useRubatoNestedSettingsPage(): boolean {
  return useRubatoSettingsBlock() !== null;
}
