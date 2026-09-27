import type { RubatoUpdateState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { requestConfirmDialog } from "../../confirmDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { rubatoApp, useRubatoUpdateCheck, type RubatoVersion } from "../../state/rubatoApp";
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

const RESTART_POLL_MS = 2_000;
// The job takes the updater's lock right after it is spawned. No lock and no
// result for our token after this long means it never ran (another job held it).
const RESTART_START_MS = 15_000;
// The job's own limits: 30 minutes for the restart, then 90 seconds for the reopen.
const RESTART_GIVE_UP_MS = 35 * 60_000;

/**
 * Follows a restart until its job reports. Only a job that stays on this side of
 * the app's quit reports here: a failure before the quit, or a server without an
 * app. A lost connection means the app is going down, which is the restart working.
 */
export async function waitForRestart(
  environmentId: Parameters<typeof rubatoApp.restartStatus>[0],
  token: string,
  poll = RESTART_POLL_MS,
): Promise<{ failed: boolean; message: string; log: string }> {
  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, poll));
    let status: Awaited<ReturnType<typeof rubatoApp.restartStatus>>;
    try {
      status = await rubatoApp.restartStatus(environmentId);
    } catch {
      if (Date.now() - startedAt > RESTART_GIVE_UP_MS)
        return { failed: true, message: "This Mac has not answered since the restart began.", log: "~/.rubato-pi/gui-update/update.log" };
      continue;
    }
    const result = status.result?.token === token ? status.result : null;
    if (result?.status === "failed")
      return { failed: true, message: result.message ?? "The restart did not finish.", log: status.log };
    if (result?.status === "succeeded") return { failed: false, message: "", log: status.log };
    if (!result && !status.busy && Date.now() - startedAt > RESTART_START_MS)
      return { failed: true, message: "The restart did not start. Another update or restart may have been running.", log: status.log };
  }
}

/** The Mac's environment once its connection is ready; null before that. */
function useRubatoEnvironment() {
  const primary = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(primary);
  return Option.isSome(prepared) ? primary : null;
}

/** Settings nav: a dot next to General while a Rubato update is waiting. */
export function RubatoUpdateDot() {
  const { check } = useRubatoUpdateCheck(useRubatoEnvironment());
  if (!check?.available) return null;
  const label = `Rubato update available: ${check.commits} new ${check.commits === 1 ? "change" : "changes"}`;
  return <span role="status" aria-label={label} className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />;
}

/**
 * Settings > General > About, the first section of General. The app is T3 built from source with Rubato on top,
 * so "the version" that matters is the Rubato checkout's commit, and updating
 * means `rubato update`, not T3's own updater.
 */
export function RubatoAboutSection() {
  const environmentId = useRubatoEnvironment();
  const updater = useDesktopUpdater();
  const [version, setVersion] = useState<RubatoVersion | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const { check, error: checkError, checking, refresh: runCheck } = useRubatoUpdateCheck(environmentId);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);

  useEffect(() => {
    if (environmentId === null) return;
    rubatoApp.version(environmentId).then(
      (next) => {
        setVersion(next);
        setVersionError(null);
      },
      (error: unknown) => setVersionError(error instanceof Error ? error.message : String(error)),
    );
  }, [environmentId]);

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
    setRestartError(null);
    let started: Awaited<ReturnType<typeof rubatoApp.restart>>;
    try {
      started = await rubatoApp.restart(environmentId);
    } catch (error) {
      setRestarting(false);
      reportError("Could not restart Rubato", error);
      return;
    }
    toastManager.add({
      type: "info",
      title: "Restarting Rubato",
      description: "The app closes and reopens by itself. A rebuild can take a few minutes.",
    });
    const outcome = await waitForRestart(environmentId, started.token);
    // A restart that reopens the app never gets here: this page goes with the app.
    setRestarting(false);
    if (outcome.failed) setRestartError(`${outcome.message} Log: ${outcome.log}`);
    else toastManager.add({ type: "success", title: "Rubato restarted" });
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
            <Button size="sm" variant="outline" disabled={checking || environmentId === null} onClick={runCheck}>
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
        description={
          restartError ? (
            <span className="text-destructive">{restartError}</span>
          ) : restarting ? (
            "Restarting… the app closes and reopens when the rebuild is done."
          ) : (
            "Rebuild from this Mac's checkout and restart the engine, the remote hub and the app. Use it after changing Rubato's code; it does not download anything."
          )
        }
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
