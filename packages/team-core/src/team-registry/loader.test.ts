/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../config"

const { TeamSpecValidationError, loadAllTeamSpecs, loadTeamSpec } = await import("./loader")

function createBaseSpec(teamName: string): {
  version: 1
  name: string
  description: string
  createdAt: number
  members: Array<Record<string, unknown>>
} {
  return {
    version: 1,
    name: teamName,
    description: `${teamName} description`,
    createdAt: Date.now(),
    members: [
      { kind: "owner", name: "implementer", model: "rubato-mock/mock-1", prompt: "implement the task" },
      { kind: "owner", name: "reviewer", model: "rubato-mock/mock-1", prompt: "review the current output" },
      { kind: "owner", name: "tester", model: "rubato-mock/mock-1", prompt: "verify the resulting behavior" },
    ],
  }
}

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
    projectConfigPath: path.join(projectRoot, ".rubato", "teams", teamName, "config.json"),
    userConfigPath: path.join(userBaseDir, "teams", teamName, "config.json"),
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function createConfig(userBaseDir: string) {
  return TeamModeConfigSchema.parse({ base_dir: userBaseDir })
}

describe("team-registry loader", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  test("loads and validates a valid 3-member team spec", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "alpha")
    await writeJsonFile(fixturePaths.userConfigPath, createBaseSpec("alpha"))

    // when
    const teamSpec = await loadTeamSpec("alpha", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

    // then
    expect(teamSpec.name).toBe("alpha")
    expect(teamSpec.members).toHaveLength(3)
  })

  test("defaults version when omitted from stored specs", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "default-version")
    const { version: _version, ...teamSpecWithoutVersion } = createBaseSpec("default-version")
    await writeJsonFile(fixturePaths.userConfigPath, teamSpecWithoutVersion)

    // when
    const teamSpec = await loadTeamSpec("default-version", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

    // then
    expect(teamSpec.version).toBe(1)
  })

  test("defaults createdAt from Date.now when omitted from stored specs", async () => {
    // given
    const originalDateNow = Date.now
    Date.now = () => 222_333_444
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "default-created-at")
    const { createdAt: _createdAt, ...teamSpecWithoutCreatedAt } = createBaseSpec("default-created-at")
    await writeJsonFile(fixturePaths.userConfigPath, teamSpecWithoutCreatedAt)

    try {
      // when
      const teamSpec = await loadTeamSpec("default-created-at", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

      // then
      expect(teamSpec.createdAt).toBe(222_333_444)
    } finally {
      Date.now = originalDateNow
    }
  })

  test("loads a single teammate without inventing a lead member", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "solo")
    await writeJsonFile(fixturePaths.userConfigPath, {
      name: "solo",
      members: [{ kind: "owner", name: "solo-owner", model: "rubato-mock/mock-1", prompt: "Implement the assigned work for the solo team." }],
    })

    // when
    const teamSpec = await loadTeamSpec("solo", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

    // then
    expect(teamSpec.members).toHaveLength(1)
  })

  test("loads multiple owner and verifier teammates without a lead member", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "peer-team")
    await writeJsonFile(fixturePaths.userConfigPath, {
      name: "peer-team",
      members: [
        { kind: "owner", name: "member-1", model: "rubato-mock/mock-1", prompt: "Implement the assigned work for member one." },
        { kind: "verifier", name: "member-2", model: "rubato-mock/mock-1", prompt: "Review the assigned work for member one." },
      ],
    })

    const teamSpec = await loadTeamSpec("peer-team", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

    expect(teamSpec.members.map((member) => member.kind)).toEqual(["owner", "verifier"])
  })

  test("prefers the project-scoped team spec when both scopes define the same name", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "dup")
    const projectSpec = { ...createBaseSpec("dup"), description: "project-owned" }
    const userSpec = { ...createBaseSpec("dup"), description: "user-owned" }

    await writeJsonFile(fixturePaths.projectConfigPath, projectSpec)
    await writeJsonFile(fixturePaths.userConfigPath, userSpec)

    // when
    const teamSpec = await loadTeamSpec("dup", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)

    // then
    expect(teamSpec.description).toBe("project-owned")
  })

  test("returns malformed team specs as data during load-all startup", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const goodFixturePaths = getFixturePaths(rootDirectory, "good")
    const badFixturePaths = getFixturePaths(rootDirectory, "broken")

    await writeJsonFile(goodFixturePaths.userConfigPath, createBaseSpec("good"))
    await mkdir(path.dirname(badFixturePaths.userConfigPath), { recursive: true })
    await writeFile(badFixturePaths.userConfigPath, "{\n  invalid json\n")

    // when
    const results = await loadAllTeamSpecs(createConfig(goodFixturePaths.userBaseDir), goodFixturePaths.projectRoot)

    // then
    expect(results).toHaveLength(2)
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "good", scope: "user", spec: expect.objectContaining({ name: "good" }) }),
      expect.objectContaining({
        name: "broken",
        scope: "user",
        error: expect.objectContaining({ name: TeamSpecValidationError.name, code: "INVALID_JSON" }),
      }),
    ]))
  })

  test("rejects specs with more than 8 members", async () => {
    // given
    const rootDirectory = await createTemporaryRoot()
    temporaryDirectories.push(rootDirectory)
    const fixturePaths = getFixturePaths(rootDirectory, "too-many")
    const teamSpec = createBaseSpec("too-many")
    teamSpec.members = Array.from({ length: 9 }, (_, index) => ({
      kind: "owner",
      name: `member-${index}`,
      model: "rubato-mock/mock-1",
      prompt: `implement task number ${index}`,
    }))
    await writeJsonFile(fixturePaths.userConfigPath, teamSpec)

    // when
    let thrownError: unknown
    try {
      await loadTeamSpec("too-many", createConfig(fixturePaths.userBaseDir), fixturePaths.projectRoot)
    } catch (error) {
      thrownError = error
    }

    // then
    expect(thrownError).toMatchObject({
      name: TeamSpecValidationError.name,
      message: "Team 'too-many' exceeds max 8 members.",
      code: "TEAM_MEMBER_LIMIT_EXCEEDED",
      field: "members",
    })
  })
})
