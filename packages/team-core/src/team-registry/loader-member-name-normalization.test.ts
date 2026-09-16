/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../config"
import { loadTeamSpec } from "./loader"

async function createTemporaryRoot(): Promise<string> {
  const directoryPath = path.join(tmpdir(), `team-mode-loader-${randomUUID()}`)
  await mkdir(directoryPath, { recursive: true })
  return directoryPath
}

function getFixturePaths(rootDirectory: string, teamName: string) {
  const projectRoot = path.join(rootDirectory, "project")
  const userBaseDir = path.join(rootDirectory, "home", ".rubato")

  return {
    projectRoot,
    userBaseDir,
    userConfigPath: path.join(userBaseDir, "teams", teamName, "config.json"),
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

describe("loadTeamSpec member name normalization", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  test("auto-assigns missing member names for specs on disk", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "autoname")
    await writeJsonFile(fixturePaths.userConfigPath, {
      name: "autoname",
      members: [
        { kind: "owner", model: "rubato-mock/mock-1", prompt: "Quick scout the workspace structure." },
        { kind: "owner", model: "rubato-mock/mock-1", prompt: "Deep dive the runtime setup." },
        { kind: "owner", model: "rubato-mock/mock-1", prompt: "Deep dive the mailbox implementation." },
        { kind: "owner", model: "rubato-mock/mock-1", prompt: "Review the combined result." },
      ],
    })

    // when
    const teamSpec = await loadTeamSpec("autoname", TeamModeConfigSchema.parse({ base_dir: fixturePaths.userBaseDir }), fixturePaths.projectRoot)

    // then
    expect(teamSpec.members.map((member) => member.name)).toEqual(["mock-1-1", "mock-1-2", "mock-1-3", "mock-1-4"])
  })
})
