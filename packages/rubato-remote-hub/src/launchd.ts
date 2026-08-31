import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writePrivateFile } from "./files.js"

const execFileAsync = promisify(execFile)
export const HUB_LAUNCHD_LABEL = "com.keepitmello.rubato.remote-hub"

export interface LaunchAgentOptions {
  readonly nodePath: string
  readonly entryPath: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly home: string
  readonly tmpdir: string
}

export function renderLaunchAgent(options: LaunchAgentOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(HUB_LAUNCHD_LABEL)}</string>
<key>ProgramArguments</key><array><string>${escapeXml(options.nodePath)}</string><string>--experimental-strip-types</string><string>${escapeXml(options.entryPath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(options.home)}</string><key>TMPDIR</key><string>${escapeXml(options.tmpdir)}</string></dict>
<key>StandardOutPath</key><string>${escapeXml(options.stdoutPath)}</string>
<key>StandardErrorPath</key><string>${escapeXml(options.stderrPath)}</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`
}

export async function installLaunchAgent(path: string, options: LaunchAgentOptions, uid = process.getuid?.()): Promise<void> {
  if (uid === undefined) throw new Error("launchd requires a user id")
  await writePrivateFile(path, renderLaunchAgent(options))
  await execFileAsync("/bin/launchctl", ["bootout", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error)) throw error
  })
  await execFileAsync("/bin/launchctl", ["bootstrap", `gui/${uid}`, path])
  await execFileAsync("/bin/launchctl", ["enable", `gui/${uid}/${HUB_LAUNCHD_LABEL}`])
  await execFileAsync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${HUB_LAUNCHD_LABEL}`])
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}
