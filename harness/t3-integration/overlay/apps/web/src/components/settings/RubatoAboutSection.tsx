import type { RubatoUpdateState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { rubatoApp, useRubatoUpdateCheck, type RubatoRestartStatus, type RubatoVersion } from "../../state/rubatoApp";
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

/** An update or restart running on the Mac: what it waits on, and whether "now" was asked. */
export interface RubatoJob {
  readonly token: string;
  readonly kind: "update" | "restart";
  readonly stage: "building" | "draining";
  readonly now: boolean;
}

/** The job holding the updater, as the page shows it; null when none runs. */
export function runningJob(status: RubatoRestartStatus): RubatoJob | null {
  const job = status.busy ? status.job : null;
  if (!job?.token) return null;
  // The job writes its kind into the result as it starts; a job too new to have written it is a restart.
  const kind = status.result?.token === job.token ? status.result.kind : "restart";
  return { token: job.token, kind, stage: job.stage, now: job.now };
}

/**
 * What a scheduled job tells the person. It runs in the background: the app stays usable, and
 * the engine restarts only once running tool calls have finished (they continue afterwards).
 */
export function jobDescription(job: RubatoJob): string {
  if (job.now) {
    return job.stage === "draining"
      ? "Restarting now. Work that was still running is cut off."
      : "Restarts as soon as the rebuild is done, without waiting for running work.";
  }
  if (job.stage === "draining") {
    return "Waiting for running tool calls to finish (up to 2 minutes). Rubato then restarts and they continue.";
  }
  return job.kind === "update"
    ? "Scheduled. Downloading and rebuilding in the background; keep working. Rubato restarts once running tool calls finish."
    : "Scheduled. Rebuilding in the background; keep working. Rubato restarts once running tool calls finish.";
}

const JOB_POLL_MS = 3_000;

/** Follows the job the updater runs, so the page shows it after it was left and opened again. */
function useRubatoJob(environmentId: Parameters<typeof rubatoApp.restartStatus>[0]) {
  const [job, setJob] = useState<RubatoJob | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    let stopped = false;
    const read = () => {
      rubatoApp.restartStatus(environmentId).then(
        (status) => { if (!stopped) setJob(runningJob(status)); },
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, JOB_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [environmentId]);
  return [job, setJob] as const;
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
  const [job, setJob] = useRubatoJob(environmentId);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [hurrying, setHurrying] = useState(false);
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

  // One press schedules it: the restart runs in the background and waits for running tool calls,
  // which continue on the new engine. No confirmation, since nothing is lost by it.
  const restart = async () => {
    setRestartError(null);
    let started: Awaited<ReturnType<typeof rubatoApp.restart>>;
    try {
      started = await rubatoApp.restart(environmentId);
    } catch (error) {
      reportError("Could not restart Rubato", error);
      return;
    }
    setJob({ token: started.token, kind: "restart", stage: "building", now: false });
    toastManager.add({
      type: "info",
      title: "Restart scheduled",
      description: "Rubato rebuilds in the background and restarts once running tool calls finish. Keep working, or press Restart now to skip the wait.",
    });
    const outcome = await waitForRestart(environmentId, started.token);
    // A restart that reopens the app never gets here: this page goes with the app.
    setJob(null);
    if (outcome.failed) setRestartError(`${outcome.message} Log: ${outcome.log}`);
    else toastManager.add({ type: "success", title: "Rubato restarted" });
  };

  // The second press: stop waiting for running work and restart as soon as the job can.
  const hurry = async () => {
    setHurrying(true);
    try {
      await rubatoApp.restartNow(environmentId);
      setJob((current) => (current ? { ...current, now: true } : current));
    } catch (error) {
      reportError("Could not restart now", error);
    } finally {
      setHurrying(false);
    }
  };

  const updateJob = job?.kind === "update" ? job : null;
  const restartJob = job?.kind === "restart" ? job : null;
  const updating = updateJob !== null || updater?.state.phase === "running";
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
        description={updateJob ? jobDescription(updateJob) : updating ? "Updating in the background…" : updateStatus}
        control={
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={checking || environmentId === null} onClick={runCheck}>
              {checking ? <Spinner className="size-3.5" /> : null}
              Check
            </Button>
            {updateJob ? (
              <Button size="sm" variant="destructive-outline" disabled={updateJob.now || hurrying} onClick={() => void hurry()}>
                {updateJob.now ? <Spinner className="size-3.5" /> : null}
                Update now
              </Button>
            ) : check?.available && updater?.bridge.checkNow ? (
              <Button size="sm" disabled={updating || job !== null} onClick={() => void update()}>
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
          ) : restartJob ? (
            jobDescription(restartJob)
          ) : (
            "Rebuild from this Mac's checkout and restart the engine, the remote hub and the app. Use it after changing Rubato's code; it does not download anything."
          )
        }
        control={
          restartJob ? (
            <Button size="sm" variant="destructive-outline" disabled={restartJob.now || hurrying} onClick={() => void hurry()}>
              {restartJob.now ? <Spinner className="size-3.5" /> : null}
              Restart now
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={job !== null || environmentId === null} onClick={() => void restart()}>
              Restart
            </Button>
          )
        }
      />
    </>
  );
}
