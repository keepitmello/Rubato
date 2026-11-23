// Rubato: restarting the Mac's Rubato from the phone uses the desktop's restart job
// (harness/t3-integration/src/app/service.mjs: restart-app, restart-status, restart-now).
// The phone's connection drops while the Mac
// restarts, so this reads the job's status again until the Mac answers with this restart's result.

/** What /rubato/app/restart-status answers (service.mjs restartStatus). */
export interface MacRestartStatus {
  readonly busy: boolean;
  readonly job?: { readonly token: string | null; readonly stage: "building" | "draining"; readonly now: boolean } | null;
  readonly result: {
    readonly token: string | null;
    readonly kind: "update" | "restart";
    readonly status: "running" | "succeeded" | "failed" | null;
    readonly message: string | null;
  } | null;
  readonly log: string;
}

export type MacRestartView =
  | { readonly phase: "idle" }
  | { readonly phase: "building" | "reconnecting" }
  | { readonly phase: "draining"; readonly now: boolean }
  | { readonly phase: "succeeded" }
  | { readonly phase: "unconfirmed" }
  | { readonly phase: "failed"; readonly message: string | null; readonly log: string };

export const MAC_RESTART_START_MS = 20_000;
// The Mac allows up to 30 minutes for the job and 20 minutes for the new window.
export const MAC_RESTART_RESULT_MS = 55 * 60_000;

/**
 * Where this restart is, from the token it started with and the Mac's last answer.
 * `status` null means the Mac did not answer (it is restarting, or the phone reconnects).
 */
export function describeMacRestart(
  token: string | null,
  status: MacRestartStatus | null,
  elapsedMs = 0,
): MacRestartView {
  if (token === null) return { phase: "idle" };
  if (status?.result?.token === token) {
    if (status.result.status === "succeeded") return { phase: "succeeded" };
    if (status.result.status === "failed") return { phase: "failed", message: status.result.message, log: status.log };
  }
  if (elapsedMs >= MAC_RESTART_RESULT_MS) return { phase: "unconfirmed" };
  if (status === null) return { phase: "reconnecting" };
  if (status.busy && status.job?.token === token) {
    return status.job.stage === "draining"
      ? { phase: "draining", now: status.job.now }
      : { phase: "building" };
  }
  if (status.result?.token !== token && elapsedMs >= MAC_RESTART_START_MS)
    return { phase: "unconfirmed" };
  // The job is not visible yet (just spawned) or the Mac is between processes.
  return { phase: "building" };
}

export function macRestartLine(view: MacRestartView): string | null {
  switch (view.phase) {
    case "idle":
      return null;
    case "building":
      return "Rebuilding Rubato on your Mac…";
    case "reconnecting":
      return "Rubato is restarting. This phone reconnects when it is back…";
    case "draining":
      return view.now
        ? "Restarting now…"
        : "Waiting for running work on your Mac to finish before restarting.";
    case "succeeded":
      return "Rubato on your Mac restarted.";
    case "unconfirmed":
      return "This phone could not confirm the restart. Check whether Rubato is open on your Mac.";
    case "failed":
      return `The restart failed${view.message ? `: ${view.message.replace(/\.?$/, ".")}` : "."} The Mac's log is at ${view.log}.`;
  }
}
