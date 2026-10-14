import { PlayIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useState } from "react";

import {
  BUILT_IN_NOTIFICATION_SOUNDS,
  defaultNotificationSound,
  listMacSounds,
  notificationSoundLabel,
  type MacSound,
  type NotificationSoundKind,
} from "../../rubatoNotificationSounds";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { previewNotificationSound } from "../../threadNotifications";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// Settings > General > Behavior, under Thread notifications: which sound plays
// when a thread finishes, and which when it needs you. Choices are T3's two
// sounds and this Mac's alert sounds (rubatoNotificationSounds.ts). Picking one
// plays it once; the button beside the picker plays it again.

const FOLDER_LABELS: Record<MacSound["folder"], string> = {
  system: "macOS",
  local: "/Library/Sounds",
  user: "~/Library/Sounds",
};

/** This Mac's sounds, read when the page opens and again each time a picker opens. */
function useMacSounds() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  const ready = environmentId !== null && Option.isSome(prepared);
  const [sounds, setSounds] = useState<MacSound[]>([]);
  const refresh = useCallback(() => {
    if (!ready || environmentId === null) return;
    void listMacSounds(environmentId)
      .then(setSounds)
      .catch(() => undefined);
  }, [environmentId, ready]);
  useEffect(refresh, [refresh]);
  return { sounds, refresh };
}

function NotificationSoundRow({
  kind,
  macSounds,
  onOpen,
}: {
  kind: NotificationSoundKind;
  macSounds: ReadonlyArray<MacSound>;
  onOpen: () => void;
}) {
  const value = useScopedSettings((settings) =>
    kind === "completion" ? settings.notificationCompletionSound : settings.notificationInputSound,
  );
  const updateSettings = useUpdateScopedSettings();
  const fallback = defaultNotificationSound(kind);
  const choose = (sound: string) =>
    updateSettings(
      kind === "completion" ? { notificationCompletionSound: sound } : { notificationInputSound: sound },
    );
  const groups = (["system", "local", "user"] as const)
    .map((folder) => ({ folder, sounds: macSounds.filter((sound) => sound.folder === folder) }))
    .filter((group) => group.sounds.length > 0);
  const label = (id: string) =>
    `${notificationSoundLabel(id, macSounds)}${id === fallback ? " (Default)" : ""}`;
  const subject = kind === "completion" ? "completion sound" : "input sound";

  return (
    <SettingsRow
      {...searchableSetting(kind === "completion" ? "notification-completion-sound" : "notification-input-sound")}
      description={
        kind === "completion"
          ? "Plays when a thread finishes, if Thread notifications include sound."
          : "Plays when a thread needs input or approval, or fails. Add your own sounds to ~/Library/Sounds."
      }
      resetAction={
        value !== fallback ? <SettingResetButton label={subject} onClick={() => choose(fallback)} /> : null
      }
      control={
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Play ${subject}`}
            onClick={() => void previewNotificationSound(kind, value)}
          >
            <PlayIcon />
          </Button>
          <Select
            value={value}
            onOpenChange={(open) => {
              if (open) onOpen();
            }}
            onValueChange={(next) => {
              if (typeof next !== "string" || next.length === 0) return;
              choose(next);
              void previewNotificationSound(kind, next);
            }}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1 sm:w-56 sm:flex-none" aria-label={`Thread ${subject}`}>
              <SelectValue>{label(value)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectGroupLabel>Built-in</SelectGroupLabel>
                {BUILT_IN_NOTIFICATION_SOUNDS.map((sound) => (
                  <SelectItem key={sound.id} hideIndicator value={sound.id}>
                    {label(sound.id)}
                  </SelectItem>
                ))}
              </SelectGroup>
              {groups.map((group) => (
                <SelectGroup key={group.folder}>
                  <SelectGroupLabel>{FOLDER_LABELS[group.folder]}</SelectGroupLabel>
                  {group.sounds.map((sound) => (
                    <SelectItem key={sound.id} hideIndicator value={sound.id}>
                      {sound.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

export function RubatoNotificationSoundSettings() {
  const { sounds, refresh } = useMacSounds();
  return (
    <>
      <NotificationSoundRow kind="completion" macSounds={sounds} onOpen={refresh} />
      <NotificationSoundRow kind="input" macSounds={sounds} onOpen={refresh} />
    </>
  );
}
