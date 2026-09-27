import type { RubatoUpdateState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { requestConfirmDialog } from "../../confirmDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { rubatoApp, type RubatoUpdateCheck, type RubatoVersion } from "../../state/rubatoApp";
import { usePreparedConnection } from "../../state/session";
import { RubatoIcon } from "../RubatoIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function reportError(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
}

/** The desktop updater's live phase; null outside the desktop app. */
function useDesktopUpdater() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.rubatoUpdate;
  const [state, setState] = useState<RubatoUpdateState>({ phase: "idle" });
  useEffect(() => {
    if (!bridge) return;
    void bridge.getState().then(setState, () => undefined);
    return bridge.onState(setState);
  }, [bridge]);
  return bridge ? { bridge, state } : null;
}

/**
 * Settings > General > About. The app is T3 built from source with Rubato on top,
 * so "the version" that matters is the Rubato checkout's commit, and updating
 * means `rubato update`, not T3's own updater.
 */
export function RubatoAboutSection() {
  const primary = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(primary);
  const environmentId = Option.isSome(prepared) ? primary : null;
  const updater = useDesktopUpdater();
  const [version, setVersion] = useState<RubatoVersion | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [check, setCheck] = useState<RubatoUpdateCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [showChanges, setShowChanges] = useState(false);

  const runCheck = useCallback(async () => {
    if (environmentId === null) return;
    setChecking(true);
    try {
      setCheck(await rubatoApp.check(environmentId));
      setCheckError(null);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, [environmentId]);

  useEffect(() => {
    if (environmentId === null) return;
    rubatoApp.version(environmentId).then(
      (next) => {
        setVersion(next);
        setVersionError(null);
      },
      (error: unknown) => setVersionError(error instanceof Error ? error.message : String(error)),
    );
    void runCheck();
  }, [environmentId, runCheck]);

  const update = async () => {
    if (!updater?.bridge.checkNow) return;
    // The desktop updater asks to confirm (it closes and reopens the app) and runs it.
    try {
      if (!(await updater.bridge.checkNow())) reportError("Could not start the update", "The updater is not set up in this app.");
    } catch (error) {
      reportError("Could not start the update", error);
    }
  };

  const restart = async () => {
    const message =
      "Restart Rubato? This rebuilds from this Mac's checkout and restarts the engine, the remote hub and this app. Running work is interrupted.";
    const answer = requestConfirmDialog(message, { variant: "destructive" });
    if (!(answer ? await answer : window.confirm(message))) return;
    setRestarting(true);
    try {
      await rubatoApp.restart(environmentId);
      toastManager.add({
        type: "info",
        title: "Restarting Rubato",
        description: "The app closes and reopens by itself. A rebuild can take a few minutes.",
      });
    } catch (error) {
      setRestarting(false);
      reportError("Could not restart Rubato", error);
    }
  };

  const updating = updater?.state.phase === "running";
  const updateStatus = checkError
    ? checkError
    : checking && !check
      ? "Checking for updates…"
      : check?.available
        ? `${check.commits} new ${check.commits === 1 ? "change" : "changes"} on rubato/base.`
        : check
          ? "Up to date."
          : "";

  return (
    <>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <RubatoIcon className="size-4" aria-hidden />
            Rubato
            {version?.short ? <code className="text-[11px] font-medium text-muted-foreground">{version.short}</code> : null}
            {version?.localChanges ? <Badge variant="outline">{version.localChanges} local changes</Badge> : null}
          </span>
        }
        description={
          versionError ??
          (version
            ? [version.subject, version.committedAt ? ago(version.committedAt) : null, version.branch]
                .filter(Boolean)
                .join(" · ")
            : "Reading the version…")
        }
        status={
          version ? (
            <span className="text-xs text-muted-foreground">
              Engine: Pi {version.pi ?? "?"} · App: T3 {APP_VERSION}
              {version.t3 ? ` (${version.t3})` : ""}
            </span>
          ) : null
        }
      />
      <SettingsRow
        title="Updates"
        description={updating ? "Updating… the app closes and reopens when it is done." : updateStatus}
        control={
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={checking || environmentId === null} onClick={() => void runCheck()}>
              {checking ? <Spinner className="size-3.5" /> : null}
              Check
            </Button>
            {check?.available && updater?.bridge.checkNow ? (
              <Button size="sm" disabled={updating} onClick={() => void update()}>
                Update
              </Button>
            ) : null}
          </span>
        }
      >
        {check?.available ? (
          <div className="mt-2 space-y-1">
            {!updater?.bridge.checkNow ? (
              <p className="text-xs text-muted-foreground">
                Run <code className="rounded bg-muted px-1">rubato update</code> on the Mac to install it.
              </p>
            ) : null}
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowChanges((value) => !value)}
            >
              {showChanges ? "Hide changes" : "Show changes"}
            </button>
            {showChanges ? (
              <ul className="space-y-0.5 text-xs">
                {check.changes.map((change) => (
                  <li key={change.short} className="flex gap-2">
                    <code className="shrink-0 text-muted-foreground">{change.short}</code>
                    <span className="min-w-0 truncate" title={change.subject}>
                      {change.subject}
                    </span>
                  </li>
                ))}
                {check.commits > check.changes.length ? (
                  <li className="text-muted-foreground">and {check.commits - check.changes.length} more</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Restart"
        description="Rebuild from this Mac's checkout and restart the engine, the remote hub and the app. Use it after changing Rubato's code; it does not download anything."
        control={
          <Button size="sm" variant="outline" disabled={restarting || environmentId === null} onClick={() => void restart()}>
            {restarting ? <Spinner className="size-3.5" /> : null}
            Restart
          </Button>
        }
      />
    </>
  );
}
