// Settings > Threads > Titles and summaries: the short ladder session titles and the
// Stats page's longest-think card run on. The server half is the memory service's
// `title-models` and `config { titleModels }` (it owns the rubato.jsonc writer). The language row
// beside it is the config's `language`: the tongue those small models write in.
import { useCallback, useEffect, useState } from "react";

import { type DreamModel, rubatoMemory } from "../../state/rubatoMemory";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { DreamModelsEditor, useReadyEnvironmentId } from "./RubatoMemorySettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// "auto" is unset: each call follows the language of what it writes about.
const AUTO_LANGUAGE = "auto";
const TITLE_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: AUTO_LANGUAGE, label: "Auto" },
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

export function RubatoTitleModelsSection() {
  const environmentId = useReadyEnvironmentId();
  const [ladder, setLadder] = useState<{ models: readonly DreamModel[]; custom: boolean; language: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setLadder(await rubatoMemory.titleModels(environmentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (models: readonly DreamModel[] | null) => {
    const previous = ladder;
    if (models && previous) setLadder({ ...previous, models, custom: true });
    try {
      await rubatoMemory.config(environmentId, {
        titleModels: models
          ? models.map((entry) => (entry.reasoning ? { model: entry.model, reasoning: entry.reasoning } : { model: entry.model }))
          : null,
      });
      if (!models) await load();
    } catch (cause) {
      setLadder(previous);
      toastManager.add({
        type: "error",
        title: "Could not save the title models",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const saveLanguage = async (value: string) => {
    const previous = ladder;
    if (previous) setLadder({ ...previous, language: value === AUTO_LANGUAGE ? null : value });
    try {
      await rubatoMemory.config(environmentId, { language: value === AUTO_LANGUAGE ? null : value });
    } catch (cause) {
      setLadder(previous);
      toastManager.add({
        type: "error",
        title: "Could not save the language",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const language = ladder?.language ?? AUTO_LANGUAGE;
  // A value written in the file that the list does not offer ("pt-BR") shows as written.
  const languages = TITLE_LANGUAGES.some((entry) => entry.value === language)
    ? TITLE_LANGUAGES
    : [...TITLE_LANGUAGES, { value: language, label: language }];

  return (
    <SettingsSection
      id="rubato-title-models"
      title="Titles and summaries"
      headerAction={
        ladder?.custom ? (
          <Button size="xs" variant="ghost" onClick={() => void save(null)}>
            Use defaults
          </Button>
        ) : null
      }
    >
      {error ? (
        <SettingsRow title="Could not read the title models" description={error} />
      ) : ladder === null ? (
        <SettingsRow title="Reading the title models" control={<Spinner className="size-4" />} />
      ) : (
        <>
          <SettingsRow
            title="Language"
            description="Session titles and summaries are written in this language. Auto follows the language of each session."
            control={
              <Select value={language} onValueChange={(value) => void saveLanguage(String(value ?? AUTO_LANGUAGE))}>
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Title language">
                  <SelectValue>{languages.find((entry) => entry.value === language)?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {languages.map((entry) => (
                    <SelectItem hideIndicator key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        <DreamModelsEditor
          models={ladder.models}
          onChange={(next) => void save(next)}
          title="Models"
          subject="titles"
          description="Session titles and the Stats page's longest-think summary use the first model that answers. The next one is the fallback."
        />
        </>
      )}
    </SettingsSection>
  );
}
