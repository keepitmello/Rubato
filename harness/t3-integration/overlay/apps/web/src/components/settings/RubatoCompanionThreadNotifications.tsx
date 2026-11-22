import * as Option from "effect/Option";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { rubatoPush } from "../../state/rubatoPush";
import { usePreparedConnection } from "../../state/session";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function RubatoCompanionThreadNotifications() {
  const gt = useGT();
  const env = usePrimaryEnvironmentId();
  const ready = Option.isSome(usePreparedConnection(env));
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setEnabled(null);
    setUnavailable(false);
    if (!env || !ready) return;
    let current = true;
    void rubatoPush.status(env).then(
      (status) => { if (current) setEnabled(status.desktopCompanionThreads ?? null); },
      () => { if (current) setUnavailable(true); },
    );
    return () => { current = false; };
  }, [env, ready]);

  const title = gt("Companion-Created Threads");
  return (
    <SettingsRow
      title={title}
      description={unavailable
        ? <T>Could not load this Mac’s notification setting.</T>
        : <T>Notify when a run started by a companion finishes or fails. Messages and requests for input or approval are separate.</T>}
      control={<Switch
        aria-label={title}
        checked={enabled ?? false}
        disabled={!env || enabled === null || saving}
        onCheckedChange={(value) => {
          if (!env) return;
          setSaving(true);
          void rubatoPush.setDesktopCompanionThreads(env, value).then(
            (result) => setEnabled(result.enabled),
            () => toastManager.add({ type: "error", title: gt("Could not save notification setting") }),
          ).finally(() => setSaving(false));
        }}
      />}
    />
  );
}
