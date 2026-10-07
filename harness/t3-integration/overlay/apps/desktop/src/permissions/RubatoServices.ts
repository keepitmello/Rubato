// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A plain Electron-side helper beside RubatoPermissions, outside the Effect runtime.
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RubatoServiceId, RubatoServiceState, RubatoServiceStatus } from "@t3tools/contracts";

// The launchd agents Rubato runs beside the app. Each has its own installer in the
// checkout; this page only reads launchd and calls those installers, so a service
// set up here is the same one `./install.sh --apply` or `rubato update` sets up.

const exec = promisify(execFile);
const LAUNCHCTL = "/bin/launchctl";

interface ServiceSpec {
  readonly id: RubatoServiceId;
  /** The launchd label, when the service has a fixed one. */
  readonly label?: string;
  /** Shown only when this machine has it set up (an Aside proxy, a speed-data upload). */
  readonly optional?: boolean;
  /** Runs on a schedule and exits between runs instead of staying up. */
  readonly periodic?: boolean;
}

export const RUBATO_SERVICES: readonly ServiceSpec[] = [
  { id: "msearch" },
  { id: "scheduler", label: "com.keepitmello.rubato.scheduler" },
  { id: "remote-hub", label: "com.keepitmello.rubato.remote-hub" },
  { id: "aside-cursor", label: "com.keepitmello.rubato.aside-cursor", optional: true },
  { id: "speed-data", label: "com.keepitmello.rubato.speed-data", optional: true, periodic: true },
];

export interface LaunchdJob {
  readonly loaded: boolean;
  readonly running: boolean;
  /** Null while it has never exited. */
  readonly lastExit: number | null;
}

/** Reads `launchctl print gui/<uid>/<label>`; a job launchd does not know is not loaded. */
export function parseLaunchctlPrint(text: string | null): LaunchdJob {
  if (text === null) return { loaded: false, running: false, lastExit: null };
  const running = /^\s*state = running$/m.test(text) || /^\s*pid = \d+$/m.test(text);
  const exit = /^\s*last exit code = (-?\d+)/m.exec(text);
  return { loaded: true, running, lastExit: exit ? Number(exit[1]) : null };
}

/** What a row shows, from launchd and whether the agent's plist exists. */
export function serviceStatus(
  job: LaunchdJob,
  installed: boolean,
  periodic = false,
): RubatoServiceStatus {
  if (job.running) return "running";
  if (!job.loaded) return installed ? "stopped" : "missing";
  // launchd keeps a crashed KeepAlive job loaded and respawns it ("spawn scheduled").
  if (job.lastExit !== null && job.lastExit !== 0) return "failed";
  return periodic ? "scheduled" : "stopped";
}

const uid = () => process.getuid?.() ?? 0;
const agents = () => path.join(homedir(), "Library", "LaunchAgents");
const exists = (file: string) => access(file).then(() => true, () => false);

async function launchctlPrint(label: string): Promise<string | null> {
  return exec(LAUNCHCTL, ["print", `gui/${uid()}/${label}`], { timeout: 5_000 }).then(
    ({ stdout }) => stdout,
    () => null,
  );
}

/** The last line the agent wrote to its error log, for a row that is failing. */
async function lastErrorLine(plist: string): Promise<string | null> {
  try {
    const { stdout } = await exec("/usr/bin/plutil", ["-extract", "StandardErrorPath", "raw", "-o", "-", plist]);
    const text = await readFile(stdout.trim(), "utf8");
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const line = lines.findLast((candidate) => /error|fail|cannot|can't|not found/i.test(candidate)) ?? lines.at(-1);
    return line ? line.slice(0, 240) : null;
  } catch {
    return null;
  }
}

// msearch's backend may run under any label (an older hand-made agent), so it is
// judged by its port, through the same check the installer uses.
async function msearchState(harness: string): Promise<RubatoServiceState> {
  const script = path.join(harness, "msearch", "redis-service.sh");
  if (!(await exists(script))) return { id: "msearch", status: "missing", detail: null };
  const healthy = await exec(script, ["--check"], { timeout: 10_000 }).then(() => true, () => false);
  return { id: "msearch", status: healthy ? "running" : "stopped", detail: null };
}

export async function readServices(harness: string | null): Promise<RubatoServiceState[]> {
  const states: RubatoServiceState[] = [];
  for (const spec of RUBATO_SERVICES) {
    if (spec.id === "msearch") {
      if (harness) states.push(await msearchState(harness));
      continue;
    }
    const plist = path.join(agents(), `${spec.label}.plist`);
    const installed = await exists(plist);
    const job = parseLaunchctlPrint(await launchctlPrint(spec.label!));
    if (spec.optional && !installed && !job.loaded) continue;
    const status = serviceStatus(job, installed, spec.periodic);
    states.push({ id: spec.id, status, detail: status === "failed" ? await lastErrorLine(plist) : null });
  }
  return states;
}

// A GUI-launched app has a bare PATH; a login shell finds node, brew and gh the way
// the user's terminal does.
const loginShell = (script: string, timeout: number) =>
  exec("/bin/bash", ["-lc", script], { timeout, maxBuffer: 4 * 1024 * 1024 });
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Starts a service the way its own installer does, or brings a registered agent back up. */
export async function startService(harness: string | null, id: RubatoServiceId): Promise<void> {
  const spec = RUBATO_SERVICES.find((candidate) => candidate.id === id);
  if (!spec) throw new Error("Unknown service");
  if (id === "msearch") {
    if (!harness) throw new Error("The Rubato checkout is unknown");
    // Installs Redis and its dependencies when they are missing, so it can take minutes.
    await loginShell(`${quoted(path.join(harness, "msearch", "redis-service.sh"))} --apply`, 1_200_000);
    return;
  }
  const plist = path.join(agents(), `${spec.label}.plist`);
  if (id === "scheduler" && !(await exists(plist))) {
    if (!harness) throw new Error("The Rubato checkout is unknown");
    await loginShell(
      `. ${quoted(path.join(harness, "scripts", "find-node.sh"))} && node="$(rubato_find_node)" && ` +
        `"$node" ${quoted(path.join(harness, "scheduler", "src", "cli.mjs"))} install`,
      120_000,
    );
    return;
  }
  if (!(await exists(plist))) throw new Error("This service is not set up on this Mac");
  const target = `gui/${uid()}/${spec.label}`;
  // Loading is a no-op error when it is already loaded; the kickstart is what restarts it.
  await exec(LAUNCHCTL, ["bootstrap", `gui/${uid()}`, plist]).catch(() => undefined);
  await exec(LAUNCHCTL, ["enable", target]).catch(() => undefined);
  await exec(LAUNCHCTL, ["kickstart", "-k", target], { timeout: 30_000 });
}

/** The checkout's harness folder, from the bridge module the server settings name. */
export async function rubatoHarness(settingsPath: string | undefined): Promise<string | null> {
  if (!settingsPath) return null;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      providerInstances?: { rubato?: { config?: { bridgeModule?: string } } };
    };
    const bridge = settings.providerInstances?.rubato?.config?.bridgeModule;
    if (!bridge || !path.isAbsolute(bridge)) return null;
    // harness/t3-integration/src/bridge.mjs
    return path.resolve(path.dirname(bridge), "..", "..");
  } catch {
    return null;
  }
}
