// Settings > Providers > Titles and summaries: the short ladder session titles and the
// Stats page's longest-think card run on. The server half is the memory service's
// `title-models` and `config { titleModels }` (it owns the rubato.jsonc writer).
import { useCallback, useEffect, useState } from "react";

import { type DreamModel, rubatoMemory } from "../../state/rubatoMemory";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { DreamModelsEditor, useReadyEnvironmentId } from "./RubatoMemorySettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function RubatoTitleModelsSection() {
  const environmentId = useReadyEnvironmentId();
  const [ladder, setLadder] = useState<{ models: readonly DreamModel[]; custom: boolean } | null>(null);
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
    if (models) setLadder({ models, custom: true });
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
        <DreamModelsEditor
          models={ladder.models}
          onChange={(next) => void save(next)}
          title="Models"
          subject="titles"
          description="Session titles and the Stats page's longest-think summary use the first model that answers. The next one is the fallback."
        />
      )}
    </SettingsSection>
  );
}
