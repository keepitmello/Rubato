import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  parsePosixProcessTable,
  selectZombieCodegraphProcesses,
  discoverCodegraphOwnedRoots,
} from "./codegraph/process-sweep"

describe("CodeGraph zombie process selection", () => {
  it("#given orphaned Rubato-owned CodeGraph commands #when selecting zombies #then ppid-one and dead-parent matches are returned", () => {
    // given
    const pluginRoot = "/tmp/rubato-owned-plugin"
    const orphanedServe = `${process.execPath} ${pluginRoot}/components/codegraph/dist/serve.js`
    const deadParentCodegraph = `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`
    const liveParentCodegraph = `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`
    const outsideRoot = `${process.execPath} /tmp/not-rubato/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`
    const processes = [
      { command: "codex app-server", pid: 200, ppid: 1 },
      { command: orphanedServe, pid: 301, ppid: 1 },
      { command: deadParentCodegraph, pid: 302, ppid: 9999 },
      { command: liveParentCodegraph, pid: 303, ppid: 200 },
      { command: outsideRoot, pid: 304, ppid: 1 },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([301, 302])
  })

  it("#given a Windows-shaped owned root #when selecting Windows zombies #then platform-specific root resolution is used", () => {
    // given
    const pluginRoot = "C:\\Users\\runner\\.codex\\plugins\\cache\\rubato-labs\\rubato\\4.15.1"
    const processes = [
      {
        command: `${process.execPath} ${pluginRoot}\\components\\codegraph\\dist\\serve.js`,
        pid: 305,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "win32" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([305])
  })

  it("#given a sibling path shares a Rubato root prefix #when selecting zombies #then the sibling is ignored", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const siblingRoot = "/tmp/rubato-evil"
    const versionRoot = "/tmp/codex/plugins/cache/rubato-labs/rubato/4.15.1"
    const siblingVersionRoot = "/tmp/codex/plugins/cache/rubato-labs/rubato/4.15.10"
    const processes = [
      {
        command: `${process.execPath} ${siblingRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`,
        pid: 311,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${siblingVersionRoot}/components/codegraph/dist/serve.js`,
        pid: 312,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${versionRoot}/components/codegraph/dist/serve.js`,
        pid: 313,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot, versionRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([313])
  })

  it("#given an owned root appears in a different argument #when the upstream binary is outside that root #then it is ignored", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const processes = [
      {
        command: [
          process.execPath,
          "/opt/not-rubato/node_modules/@colbymchenry/codegraph/bin/codegraph.js",
          "serve",
          "--mcp",
          "--cache",
          pluginRoot,
        ].join(" "),
        pid: 321,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`,
        pid: 322,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([322])
  })

  it("#given an upstream package path is only a data argument #when selecting zombies #then it is ignored", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const upstreamPath = `${pluginRoot}/node_modules/@colbymchenry/codegraph/README.md`
    const processes = [
      {
        command: `/usr/bin/python3 /tmp/tool.py --template ${upstreamPath}`,
        pid: 323,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`,
        pid: 324,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([324])
  })

  it("#given a command only mentions the serve wrapper path #when selecting zombies #then it is ignored", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const serveWrapper = `${pluginRoot}/components/codegraph/dist/serve.js`
    const processes = [
      {
        command: `/usr/bin/python3 /tmp/tool.py --template ${serveWrapper}`,
        pid: 331,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${serveWrapper}.backup`,
        pid: 332,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${serveWrapper}`,
        pid: 333,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.pid)).toEqual([333])
  })

  it("#given a detached upstream daemon with a --path argument #when selecting zombies #then it is matched as daemon-shaped with the project root extracted", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const projectRoot = "/tmp/proj-a"
    const processes = [
      {
        command: `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp --path ${projectRoot}`,
        pid: 341,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies).toEqual([
      {
        command: processes[0]?.command,
        daemonProjectRoot: projectRoot,
        matchKind: "upstream-daemon",
        matchedRoot: pluginRoot,
        pid: 341,
        ppid: 1,
      },
    ])
  })

  it("#given provisioned standalone daemon shapes #when selecting zombies #then both launcher and post-exec bundle forms are daemon-shaped", () => {
    // given
    const installDir = "/tmp/rubato-install"
    const projectRoot = "/tmp/proj-b"
    const launcher = `${installDir}/bin/codegraph serve --mcp --path ${projectRoot}`
    const bundle = `${installDir}/node --liftoff-only ${installDir}/lib/dist/bin/codegraph.js serve --mcp --path ${projectRoot}`
    const processes = [
      { command: launcher, pid: 351, ppid: 1 },
      { command: bundle, pid: 352, ppid: 1 },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [installDir], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => [processInfo.pid, processInfo.matchKind, processInfo.daemonProjectRoot])).toEqual([
      [351, "upstream-daemon", projectRoot],
      [352, "upstream-daemon", projectRoot],
    ])
  })

  it("#given a Windows standalone daemon shape #when selecting zombies #then it is daemon-shaped with the raw --path value preserved", () => {
    // given
    const installDir = "C:\\Users\\runner\\.rubato\\codegraph"
    const processes = [
      {
        command: `${installDir}\\bin\\codegraph.exe serve --mcp --path C:\\proj\\app`,
        pid: 353,
        ppid: 1,
      },
      {
        command: `C:\\node\\node.exe ${installDir}\\lib\\dist\\bin\\codegraph.js serve --mcp --path C:\\proj\\app`,
        pid: 354,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [installDir], platform: "win32" })

    // then
    expect(zombies.map((processInfo) => [processInfo.pid, processInfo.matchKind, processInfo.daemonProjectRoot])).toEqual([
      [353, "upstream-daemon", "C:\\proj\\app"],
      [354, "upstream-daemon", "C:\\proj\\app"],
    ])
  })

  it("#given an upstream serve process without --path #when selecting zombies #then it stays a plain upstream-codegraph zombie", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const processes = [
      {
        command: `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp`,
        pid: 355,
        ppid: 1,
      },
      {
        command: `${process.execPath} ${pluginRoot}/node_modules/@colbymchenry/codegraph/bin/codegraph.js serve --mcp --path`,
        pid: 356,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => [processInfo.pid, processInfo.matchKind])).toEqual([
      [355, "upstream-codegraph"],
      [356, "upstream-codegraph"],
    ])
  })

  it("#given a daemon-shaped process with a live parent #when selecting zombies #then it is not a candidate", () => {
    // given
    const installDir = "/tmp/rubato-install"
    const processes = [
      { command: "codex app-server", pid: 200, ppid: 1 },
      {
        command: `${installDir}/bin/codegraph serve --mcp --path /tmp/proj-c`,
        pid: 357,
        ppid: 200,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [installDir], platform: "linux" })

    // then
    expect(zombies).toEqual([])
  })

  it("#given a daemon-shaped command outside any owned root #when selecting zombies #then it is ignored", () => {
    // given
    const pluginRoot = "/tmp/rubato-plugin"
    const processes = [
      {
        command: `/opt/not-rubato/bin/codegraph serve --mcp --path /tmp/proj-d`,
        pid: 358,
        ppid: 1,
      },
      {
        command: `/opt/not-rubato/node /opt/not-rubato/lib/dist/bin/codegraph.js serve --mcp --path /tmp/proj-d`,
        pid: 359,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [pluginRoot], platform: "linux" })

    // then
    expect(zombies).toEqual([])
  })

  it("#given a quoted --path value with spaces #when selecting zombies #then the quoted project root is extracted", () => {
    // given
    const installDir = "/tmp/rubato-install"
    const processes = [
      {
        command: `${installDir}/bin/codegraph serve --mcp --path "/tmp/proj with spaces"`,
        pid: 360,
        ppid: 1,
      },
    ]

    // when
    const zombies = selectZombieCodegraphProcesses(processes, { ownedRoots: [installDir], platform: "linux" })

    // then
    expect(zombies.map((processInfo) => processInfo.daemonProjectRoot)).toEqual(["/tmp/proj with spaces"])
  })

  it("#given a POSIX ps table #when parsing process rows #then pid ppid and full command are preserved", () => {
    // given
    const output = [
      "  101     1 /usr/bin/node /tmp/rubato/components/codegraph/dist/serve.js",
      "  202   101 /bin/sh -lc echo still includes spaces",
      "not-a-pid line",
    ].join("\n")

    // when
    const parsed = parsePosixProcessTable(output)

    // then
    expect(parsed).toEqual([
      { command: "/usr/bin/node /tmp/rubato/components/codegraph/dist/serve.js", pid: 101, ppid: 1 },
      { command: "/bin/sh -lc echo still includes spaces", pid: 202, ppid: 101 },
    ])
  })
})

describe("CodeGraph owned root discovery", () => {
  it("#given Codex plugin cache has a rubato plugin and an unrelated leftover #when discovering roots #then only the rubato plugin slug is trusted", () => {
    // given
    const codexHome = mkdtempSync(join(tmpdir(), "rubato-codegraph-roots-codex-"))
    try {
      const trustedRoot = join(codexHome, "plugins", "cache", "rubato-labs", "rubato", "4.15.1")
      const untrustedRoot = join(codexHome, "plugins", "cache", "evil", "unrelated", "1.0.0")
      mkdirSync(trustedRoot, { recursive: true })
      mkdirSync(untrustedRoot, { recursive: true })

      // when
      const roots = discoverCodegraphOwnedRoots({ codexHome, homeDir: join(codexHome, "home") })

      // then
      expect(roots).toContain(trustedRoot)
      expect(roots).not.toContain(untrustedRoot)
    } finally {
      rmSync(codexHome, { force: true, recursive: true })
    }
  })

  it("#given ambient CODEGRAPH_INSTALL_DIR points outside Rubato state #when discovering roots #then it is not trusted", () => {
    // given
    const homeDir = mkdtempSync(join(tmpdir(), "rubato-codegraph-roots-home-"))
    try {
      const inheritedInstallDir = "/opt/not-rubato"

      // when
      const roots = discoverCodegraphOwnedRoots({
        env: { CODEGRAPH_INSTALL_DIR: inheritedInstallDir },
        homeDir,
      })

      // then
      expect(roots).not.toContain(inheritedInstallDir)
      expect(roots).toContain(join(homeDir, ".rubato", "codegraph"))
    } finally {
      rmSync(homeDir, { force: true, recursive: true })
    }
  })
})
