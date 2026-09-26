// Replacing the installed engine and restarting the profile engine that runs it are one step.
//
// The profile engine (the detached pi-server daemon) loads the stock-engine build into memory
// once, at start, and keeps reading the install receipt from disk afterwards. A rebuild that
// leaves it running pairs old in-memory code with a new receipt: on 2026-09-27 a rebuild dropped
// two payloads from the manifest, the old validator rejected the new receipt, and the GUI's
// catalogue failed until the engine was restarted by hand. So every path that replaces the
// install restarts the engine right after, here, unless its caller owns that restart itself.
//
// Only node's own modules are imported up front. The launcher module and the pi-server client
// load on demand, and only on a machine that has a profile engine descriptor at all: a fresh
// install has no engine to restart and may not have the pi-server dependencies yet.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The replacement was not made: the command runs inside a conversation the engine hosts. */
export const HOSTED_EXIT = 20;

async function descriptorPathFor(env) {
  const { resolveLaunchAgentDir } = await import("../rubato-pi/src/launch.mjs");
  return join(resolveLaunchAgentDir(env), "server", "connection.json");
}

export async function engineHostsCaller({ env = process.env } = {}) {
  const descriptorPath = await descriptorPathFor(env);
  if (!existsSync(descriptorPath)) return false;
  const { profileEngineHostsCaller } = await import("./restart-profile-engine.mjs");
  return profileEngineHostsCaller({ descriptorPath });
}

export async function restartLiveEngine({ env = process.env, stderr = process.stderr } = {}) {
  const descriptorPath = await descriptorPathFor(env);
  if (!existsSync(descriptorPath)) return { ok: true, token: "missing" };
  const { restartProfileEngine, reportRestart, restartSucceeded } = await import("./restart-profile-engine.mjs");
  const result = await restartProfileEngine({ descriptorPath });
  return { ok: restartSucceeded(result), token: reportRestart(result, stderr) };
}

/**
 * Runs `replace` (a build that swaps the installed engine) and restarts the live profile engine
 * onto it. Returns 0, HOSTED_EXIT when nothing was replaced, or 1 when the new build is in place
 * but the old engine is still running.
 *
 * RUBATO_PROFILE_RESTART_OWNER=1 means the caller (`rubato restart`, `rubato update`) restarts
 * the engine itself after its other steps; restarting here too would report the engine as
 * already gone there.
 *
 * A caller hosted by the engine is refused before anything is built. Restarting would cut the
 * very conversation that ran the command (and kill the command with it); building without the
 * restart is the stale pairing this module exists to prevent. Left alone, engine and install stay
 * consistent — both old — and the next build from outside that engine catches up.
 */
export async function replaceLiveEngine({
  replace, env = process.env, stderr = process.stderr,
  hostsCaller = engineHostsCaller, restart = restartLiveEngine,
} = {}) {
  if (env.RUBATO_PROFILE_RESTART_OWNER === "1") {
    await replace();
    return 0;
  }
  if (await hostsCaller({ env })) {
    stderr.write("rubato: 엔진을 다시 만들지 않았습니다 — 이 명령이 프로필 엔진 안의 대화에서 돌고 있어, "
      + "새 엔진으로 다시 띄우면 이 명령을 부른 대화가 끊깁니다. 엔진과 설치본은 둘 다 옛 코드로 맞물린 채입니다. "
      + "대화 밖 터미널에서: rubato restart\n");
    return HOSTED_EXIT;
  }
  await replace();
  const { ok, token } = await restart({ env, stderr });
  if (ok) {
    if (token === "restarted") stderr.write("rubato: 새 엔진으로 프로필 엔진을 다시 띄웠습니다\n");
    return 0;
  }
  stderr.write(`rubato: 엔진은 새로 만들었지만 프로필 엔진을 다시 띄우지 못했습니다 (${token}). `
    + "옛 코드가 새 설치본 위에서 돌고 있습니다 — 손으로: pgrep -lf 'cli.mjs --agent-dir'\n");
  return 1;
}
