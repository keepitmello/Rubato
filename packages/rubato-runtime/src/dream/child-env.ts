import { homedir } from "node:os"
import { join } from "node:path"

export function agentDir(env: NodeJS.ProcessEnv): string {
  const pinned = env.RUBATO_PI_CODING_AGENT_DIR
  return pinned !== undefined && pinned.trim() !== "" ? pinned : join(env.HOME ?? homedir(), ".rubato-pi", "agent")
}

// The dream child is a fresh engine process, not a child of whatever session ran this command:
// drop the caller's session identity and pin the profile directory, as `rubato dispatch` does.
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of [
    "PI_CODING_AGENT_SESSION_DIR", "SENPI_CODING_AGENT_SESSION_DIR", "PI_SESSION_FILE", "PI_SESSION_ID",
    "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_PACKAGE_DIR", "SENPI_PACKAGE_DIR",
    "PI_MANAGED_INSTALL_ROOT", "PI_CODING_AGENT",
    // The session's context mode: with its origin marker the child treats the launch's mode as
    // inherited, re-resolves it and stops at the notes gate (every rung failed this way).
    "RUBATO_CONTEXT_MODE", "RUBATO_CONTEXT_MODE_ORIGIN",
  ]) delete out[key]
  const dir = agentDir(env)
  out.PI_CODING_AGENT_DIR = dir
  out.RUBATO_PI_CODING_AGENT_DIR = dir
  out.DO_NOT_TRACK = "1"
  return out
}
