import type {
  RubatoPermissionAction,
  RubatoPermissionId,
  RubatoPermissionStatus,
  RubatoPermissionsState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PERMISSIONS: Record<RubatoPermissionId, { title: string; description: string }> = {
  screen: {
    title: "Screen Recording",
    description: "Lets agents capture the screen to check their work (screencapture, Peekaboo).",
  },
  accessibility: {
    title: "Accessibility",
    description: "Lets agents click buttons and type in other apps.",
  },
  fullDisk: {
    title: "Full Disk Access",
    description: "Lets agents read folders macOS protects, such as Mail, Messages and Safari history.",
  },
  automation: {
    title: "Automation (System Events)",
    description:
      "Lets agents control other apps with AppleScript. macOS asks separately the first time an agent uses another app, such as Finder or Safari.",
  },
};

const STATUS: Record<RubatoPermissionStatus, { label: string; variant: "success" | "warning" | "info" }> = {
  granted: { label: "Allowed", variant: "success" },
  denied: { label: "Off", variant: "warning" },
  unknown: { label: "Unknown", variant: "info" },
};

// Shown when a permission is off here even though System Settings may show it on.
const STALE_HINT =
  "If System Settings shows this on but it looks off here, the permission belongs to an earlier build. Re-register clears the old entry and asks again.";

function hint(id: RubatoPermissionId, status: RubatoPermissionStatus): string | null {
  if (status === "granted") return null;
  if (id === "screen")
    return `Relaunch the app after allowing it to see the change here. ${STALE_HINT}`;
  if (id === "fullDisk")
    return "If Rubato is not in the list, drag the Rubato icon shown over System Settings into the list.";
  if (id === "automation" && status === "unknown")
    return "The status can't be read without Full Disk Access. Request checks it right away.";
  return STALE_HINT;
}

export function RubatoPermissionsSettings() {
  const bridge = window.desktopBridge?.rubatoPermissions;
  const isMac = window.desktopBridge?.getClientPlatform?.() === "darwin";
  const [state, setState] = useState<RubatoPermissionsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!bridge || !isMac || busyRef.current) return;
    try {
      setState(await bridge.getState());
    } catch (cause) {
      console.warn("Rubato permissions:", cause);
    }
  }, [bridge, isMac]);

  useEffect(() => {
    void refresh();
    // The user grants in System Settings and comes back; check again then,
    // and keep checking while this page is visible.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = async (id: RubatoPermissionId | null, action: RubatoPermissionAction) => {
    if (!bridge || busyRef.current) return;
    busyRef.current = true;
    setBusy(`${id ?? "app"}:${action}`);
    setError(null);
    try {
      setState(await bridge.act(id, action));
    } catch (cause) {
      console.warn("Rubato permissions:", cause);
      setError("Could not complete the request. Change it in System Settings → Privacy & Security.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  if (!bridge || !isMac) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="macOS Permissions">
          <SettingsRow title="Available in the macOS desktop app only." />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const statusOf = (id: RubatoPermissionId) =>
    state?.items.find((item) => item.id === id)?.status ?? "unknown";

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("rubato-permissions")}
        title="macOS Permissions"
        headerAction={
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      >
        <SettingsRow
          title="Agent permissions"
          description="Tools agents run (screencapture, Peekaboo, osascript) use the Rubato app's permissions. Allowing them here applies to every session."
          status={
            state?.signing === "stable"
              ? "This app has a stable signature, so permissions survive rubato update and restart."
              : state?.signing === "adhoc"
                ? "This app has an ad-hoc signature, so every rebuild resets permissions. Run rubato update once in a terminal to switch to a stable signature."
                : undefined
          }
        />
        {(Object.keys(PERMISSIONS) as RubatoPermissionId[]).map((id) => {
          const status = statusOf(id);
          const note = state ? hint(id, status) : null;
          return (
            <SettingsRow
              key={id}
              title={
                <span className="flex items-center gap-2">
                  {PERMISSIONS[id].title}
                  {state ? (
                    <Badge size="sm" variant={STATUS[status].variant}>
                      {STATUS[status].label}
                    </Badge>
                  ) : null}
                </span>
              }
              description={PERMISSIONS[id].description}
              status={note ?? undefined}
              control={
                status === "granted" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(id, "open")}
                  >
                    System Settings
                  </Button>
                ) : (
                  <span className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void act(id, "request")}
                    >
                      {busy === `${id}:request` ? "Opening…" : "Request"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void act(id, "reset")}
                    >
                      Re-register
                    </Button>
                    {id === "screen" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void act(null, "relaunch")}
                      >
                        Relaunch app
                      </Button>
                    ) : null}
                  </span>
                )
              }
            />
          );
        })}
        {error ? <SettingsRow title="Error" description={error} /> : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
