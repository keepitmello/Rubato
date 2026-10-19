// A Settings page laid out by rubatoSettingsLayout.ts: each block draws T3's
// own panels through a filter (rubatoSettingsBlock.tsx), under our heading
// when the block has one (settings-layout-edits.mjs).
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ComponentType } from "react";

import { Button } from "../ui/button";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { RubatoAboutSection } from "./RubatoAboutSection";
import { RubatoCompanionSettingsPanel } from "./RubatoCompanionSettings";
import { RubatoHomeProjectsSettingsRow } from "./RubatoHomeProjectsSetting";
import { RubatoSidebarSectionsSettingsRows } from "./RubatoSidebarSectionsSetting";
import { RubatoTitleModelsSection } from "./RubatoTitleModels";
import { RubatoPhoneSettingsPanel } from "./RubatoPhoneSettings";
import { RubatoVoiceSettingsSection } from "./RubatoVoiceSettings";
import { RubatoSettingsBlockScope } from "./rubatoSettingsBlock";
import {
  RUBATO_FALLBACK_BLOCK,
  RUBATO_SETTINGS_PAGES,
  rubatoBlockFilter,
  rubatoBlockId,
  unplacedGeneralRows,
  type RubatoSettingsBlock,
  type RubatoSettingsPage as RubatoSettingsPageSpec,
  type RubatoSettingsSource,
} from "./rubatoSettingsLayout";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { SETTINGS_SEARCH_ITEMS, type SettingsPath } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { StorageSettingsPanel } from "./StorageSettings";

/** macOS permissions live on their own page; General opens it. */
function PermissionsLinkRow() {
  const navigate = useNavigate();
  return (
    <SettingsRow
      id="rubato-permissions-link"
      title="macOS permissions"
      description="Screen recording, accessibility and automation for the commands sessions run."
      control={
        <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/settings/permissions" })}>
          Open
        </Button>
      }
    />
  );
}

const SOURCES: Readonly<Record<RubatoSettingsSource, ComponentType>> = {
  general: GeneralSettingsPanel,
  storage: StorageSettingsPanel,
  sourceControl: SourceControlSettingsPanel,
  integrations: IntegrationsSettingsPanel,
  connections: ConnectionsSettings,
  phone: RubatoPhoneSettingsPanel,
  about: RubatoAboutSection,
  homeProjects: RubatoHomeProjectsSettingsRow,
  sidebarSections: RubatoSidebarSectionsSettingsRows,
  titleModels: RubatoTitleModelsSection,
  voice: RubatoVoiceSettingsSection,
  permissionsLink: PermissionsLinkRow,
  companion: RubatoCompanionSettingsPanel,
};

const FALLBACK_ROWS = unplacedGeneralRows(SETTINGS_SEARCH_ITEMS);

function Block({ page, block }: { page: RubatoSettingsPageSpec; block: RubatoSettingsBlock }) {
  const filter = useMemo(() => rubatoBlockFilter(page, block, FALLBACK_ROWS), [page, block]);
  if (rubatoBlockId(page, block) === RUBATO_FALLBACK_BLOCK && FALLBACK_ROWS.length === 0) return null;
  const body = (
    <RubatoSettingsBlockScope value={filter}>
      {block.sources.map((source) => {
        const Source = SOURCES[source];
        return <Source key={source} />;
      })}
    </RubatoSettingsBlockScope>
  );
  if (block.title === undefined) return body;
  return (
    // A block whose rows are all off (a feature the environment lacks) hides with its heading.
    <SettingsSection
      {...(block.anchor ? { id: block.anchor } : {})}
      title={block.title}
      className="has-[>div:last-child:empty]:hidden"
    >
      {body}
    </SettingsSection>
  );
}

export function RubatoSettingsPage({ path }: { path: SettingsPath }) {
  const page = RUBATO_SETTINGS_PAGES.find((candidate) => candidate.path === path);
  return (
    <SettingsPageContainer>
      {page?.blocks?.map((block) => <Block key={block.key} page={page} block={block} />)}
    </SettingsPageContainer>
  );
}
