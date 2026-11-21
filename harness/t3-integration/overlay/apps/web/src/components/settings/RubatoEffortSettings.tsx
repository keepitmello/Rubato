// Settings > Providers: how hard new conversations think. One level for every model at the top of
// the page, and a model's own level beside it in "Models in the picker". Both are Pi's settings
// (src/auth/effort.mjs); the conversation picker starts at the same level because the catalogue
// reads them too (pi-server host.mjs withStartThinkingLevels). A level picked in a conversation
// stays in that conversation.
import { Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { rubatoAuth, type EffortChange, type EffortLevel, type EffortSettings } from "../../state/rubatoAuth";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  DEFAULT_CHOICES,
  EFFORT_LABEL,
  isEffortLevel,
  modelEffortView,
  offeredLevels,
} from "./RubatoEffortSettings.logic";

type EnvironmentId = Parameters<typeof rubatoAuth.effort>[0];

export interface EffortState {
  readonly settings: EffortSettings | null;
  readonly saving: boolean;
  readonly change: (change: EffortChange) => void;
}

/**
 * The page's effort settings. `onSaved` runs after each change: the catalogue the pickers read
 * carries the levels, so it is read again.
 */
export function useEffortSettings(environmentId: EnvironmentId, onSaved: () => void): EffortState {
  const [settings, setSettings] = useState<EffortSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (environmentId === null) return;
    let live = true;
    rubatoAuth.effort(environmentId).then(
      (next) => live && setSettings(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [environmentId]);

  const change = useCallback(
    (next: EffortChange) => {
      if (environmentId === null) return;
      setSaving(true);
      rubatoAuth
        .setEffort(environmentId, next)
        .then((saved) => {
          setSettings(saved);
          onSaved();
        })
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not change thinking effort",
            description: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => setSaving(false));
    },
    [environmentId, onSaved],
  );

  return { settings, saving, change };
}

/** The top of the page: the level every model starts at unless it has its own. */
export function EffortDefaultSection({ effort }: { effort: EffortState }) {
  const current = effort.settings?.defaultLevel ?? null;
  return (
    <SettingsSection id="rubato-thinking-effort" title="Thinking effort">
      <SettingsRow
        title="New conversations think at"
        description="Used for every model unless that model has its own level below. A level a model doesn't offer moves to its nearest one. A level picked in a conversation stays in that conversation."
        control={
          <ToggleGroup
            aria-label="New conversations think at"
            variant="segmented"
            disabled={effort.settings === null || effort.saving}
            value={current ? [current] : []}
            onValueChange={(next) => {
              const level = (next as string[]).find((value) => value !== current);
              if (isEffortLevel(level)) effort.change({ defaultLevel: level });
            }}
          >
            {DEFAULT_CHOICES.map((level) => (
              <Toggle key={level} value={level} className="px-3">
                {EFFORT_LABEL[level]}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
    </SettingsSection>
  );
}

const FOLLOW = "default";

/**
 * A model row's level: muted "Default · High" while it follows the level for every model, the
 * model's own level in the accent color with a way back otherwise.
 */
export function ModelEffortControl({
  slug,
  name,
  capabilities,
  effort,
}: {
  slug: string;
  name: string;
  capabilities: unknown;
  effort: EffortState;
}) {
  const offered = offeredLevels(capabilities);
  if (offered.length === 0) return null;
  const labelOf = (level: string | null) =>
    offered.find((option) => option.id === level)?.label ?? (isEffortLevel(level) ? EFFORT_LABEL[level] : null);
  const { own, followed } = modelEffortView(
    slug,
    offered.map((option) => option.id),
    effort.settings,
  );
  const followedLabel = labelOf(followed);
  const disabled = effort.settings === null || effort.saving;
  return (
    <div className="flex items-center gap-1">
      <Select
        value={own ?? FOLLOW}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === FOLLOW) effort.change({ model: slug, level: null });
          else if (isEffortLevel(next) && next !== own) effort.change({ model: slug, level: next });
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={`${name} thinking effort`}
          className={cn(
            "w-44 gap-2",
            own ? "border-primary/50 bg-primary/10 text-foreground" : "text-muted-foreground",
          )}
        >
          <SelectValue>
            {own ? labelOf(own) : followedLabel ? `Default · ${followedLabel}` : "Default"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value={FOLLOW}>
            <span className="flex w-full items-center justify-between gap-4">
              <span>Default</span>
              {followedLabel ? <span className="text-muted-foreground text-xs">{followedLabel} now</span> : null}
            </span>
          </SelectItem>
          {offered.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {own ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`Back to the default for ${name}`}
                onClick={() => effort.change({ model: slug, level: null })}
              />
            }
          >
            <Undo2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Back to the default</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="size-6" aria-hidden />
      )}
    </div>
  );
}

