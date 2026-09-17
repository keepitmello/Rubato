import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { type SenpiTeamMemberPorts, loadTeamRegistry } from "./index"

const created: string[] = []
const MODEL = "rubato-mock/mock-1"

const allowAll: SenpiTeamMemberPorts = {
  isModelAvailable: (model) => model === MODEL,
  modelNames: [MODEL],
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "senpi-task-team-registry-"))
  created.push(dir)
  return dir
}

function writeProjectTeamSpec(projectRoot: string, teamName: string, spec: unknown): void {
  const teamDir = join(projectRoot, ".rubato", "teams", teamName)
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(join(teamDir, "config.json"), JSON.stringify(spec), "utf8")
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("loadTeamRegistry", () => {
  test("#given a rubato.json teams section with model members #when loaded #then it round-trips into a team-core spec", async () => {
    // given
    const projectRoot = makeProjectDir()
    const rubatoTeams = {
      "research-team": {
        members: [
          { kind: "owner", model: MODEL, prompt: "investigate" },
          { name: "finder", kind: "owner", model: MODEL, prompt: "find evidence" },
        ],
      },
    }

    // when
    const result = await loadTeamRegistry({ projectRoot, rubatoTeams, ports: allowAll })

    // then
    expect(result.errors).toEqual([])
    expect(result.teams).toHaveLength(1)
    const entry = result.teams[0]
    expect(entry?.name).toBe("research-team")
    expect(entry?.source).toBe("rubato-json")
    expect(entry?.spec.members).toHaveLength(2)
  })

  test("#given a directory spec and a rubato.json spec sharing a name #when loaded #then the project directory wins", async () => {
    // given
    const projectRoot = makeProjectDir()
    writeProjectTeamSpec(projectRoot, "shared", {
      members: [{ kind: "owner", model: MODEL, prompt: "project work" }],
    })
    const rubatoTeams = {
      shared: { members: [{ kind: "owner", model: MODEL, prompt: "config work" }] },
    }

    // when
    const result = await loadTeamRegistry({ projectRoot, rubatoTeams, ports: allowAll })

    // then
    expect(result.teams).toHaveLength(1)
    const entry = result.teams[0]
    expect(entry?.name).toBe("shared")
    expect(entry?.source).toBe("project")
    expect(entry?.spec.members[0]?.kind).toBe("owner")
  })

  test("#given a member with an unresolvable kind #when loaded #then an error is recorded and zero teams spawn", async () => {
    // given
    const projectRoot = makeProjectDir()
    const rubatoTeams = {
      "bad-team": { members: [{ name: "x", kind: "owner", model: "missing/model", prompt: "work" }] },
    }
    const ports: SenpiTeamMemberPorts = {
      isModelAvailable: () => false,
    }

    // when
    const result = await loadTeamRegistry({ projectRoot, rubatoTeams, ports })

    // then
    expect(result.teams).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.name).toBe("bad-team")
    expect(result.errors[0]?.code).toBe("MODEL_UNAVAILABLE")
  })

  test("#given a team declaring a raw lead field #when loaded #then it is rejected and spawns zero members", async () => {
    // given
    const projectRoot = makeProjectDir()
    const rubatoTeams = {
      "lead-field-team": {
        lead: { kind: "owner", model: "rubato-mock/mock-1" },
        members: [{ kind: "owner", model: MODEL, prompt: "work" }],
      },
    }

    // when
    const result = await loadTeamRegistry({ projectRoot, rubatoTeams, ports: allowAll })

    // then
    expect(result.teams).toEqual([])
    expect(result.errors[0]?.code).toBe("RESERVED_LEAD_FIELD")
  })

  test("#given no team sources #when loaded #then it returns empty teams and errors", async () => {
    // given
    const projectRoot = makeProjectDir()

    // when
    const result = await loadTeamRegistry({ projectRoot, ports: allowAll })

    // then
    expect(result.teams).toEqual([])
    expect(result.errors).toEqual([])
  })
})
