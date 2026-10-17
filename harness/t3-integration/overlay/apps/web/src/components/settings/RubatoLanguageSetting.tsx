import { setUiLanguage, type UiLanguage } from "../../rubatoI18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// Settings > Appearance > Interface: the language of the interface text
// (rubatoI18n.ts). Each language is named in itself, so someone who cannot
// read the current one still finds their own.

const LANGUAGES: ReadonlyArray<{ readonly id: UiLanguage; readonly name: string }> = [
  { id: "en", name: "English" },
  { id: "ko", name: "한국어" },
];

export function RubatoLanguageSetting() {
  const language = useScopedSettings((settings) => settings.uiLanguage);
  const updateSettings = useUpdateScopedSettings();
  const choose = (next: UiLanguage) => {
    updateSettings({ uiLanguage: next });
    void setUiLanguage(next);
  };
  const name = (id: UiLanguage) => LANGUAGES.find((entry) => entry.id === id)?.name ?? id;

  return (
    <SettingsRow
      {...searchableSetting("ui-language")}
      description="Language of menus, buttons and settings. Messages, code and file names stay as written."
      resetAction={language !== "en" ? <SettingResetButton label="language" onClick={() => choose("en")} /> : null}
      control={
        <Select
          value={language}
          onValueChange={(next) => {
            if (next === "en" || next === "ko") choose(next);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Interface language">
            <SelectValue>
              <span translate="no">{name(language)}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {LANGUAGES.map((entry) => (
              <SelectItem key={entry.id} hideIndicator value={entry.id}>
                <span translate="no">{entry.name}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
