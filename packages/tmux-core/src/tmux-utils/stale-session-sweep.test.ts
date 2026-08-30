import { beforeEach, describe, expect, it, mock } from "bun:test"
import { sweepStaleRubatoAgentSessionsWith, sweepTmuxSessionsWith, type SweepDeps } from "./stale-session-sweep"

type SweepFixture = {
	deps: SweepDeps
	candidates: string[]
	killed: string[]
	killSessionMock: ReturnType<typeof mock>
	setCandidates: (sessions: string[]) => void
	setAlive: (predicate: (pid: number) => boolean) => void
}

function createFixture(): SweepFixture {
	const candidates: string[] = []
	const killed: string[] = []
	let aliveCheck: (pid: number) => boolean = () => false

	const killSessionMock = mock(async (sessionName: string): Promise<boolean> => {
		killed.push(sessionName)
		return true
	})

	const deps: SweepDeps = {
		isInsideTmux: () => true,
		getTmuxPath: async () => "tmux",
		listCandidateSessions: async () => [...candidates],
		killSession: killSessionMock,
		processAlive: (pid) => aliveCheck(pid),
		currentPid: 12345,
		log: () => undefined,
	}

	return {
		deps,
		candidates,
		killed,
		killSessionMock,
		setCandidates: (sessions) => {
			candidates.length = 0
			candidates.push(...sessions)
		},
		setAlive: (predicate) => {
			aliveCheck = predicate
		},
	}
}

describe("sweepStaleRubatoAgentSessionsWith", () => {
	let fixture: SweepFixture

	beforeEach(() => {
		fixture = createFixture()
	})

	it("#given not inside tmux #when sweep called #then returns 0 without listing", async () => {
		// given
		const deps: SweepDeps = { ...fixture.deps, isInsideTmux: () => false }

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(deps)

		// then
		expect(result).toBe(0)
	})

	it("#given tmux not found #when sweep called #then returns 0 without listing", async () => {
		// given
		const deps: SweepDeps = { ...fixture.deps, getTmuxPath: async () => undefined }

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(deps)

		// then
		expect(result).toBe(0)
	})

	it("#given candidate list is empty #when sweep called #then returns 0 and does not kill anything", async () => {
		// given
		fixture.setCandidates([])

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(0)
		expect(fixture.killed).toEqual([])
	})

	it("#given sessions with dead PIDs #when sweep called #then each dead session is killed once", async () => {
		// given
		fixture.setCandidates(["rubato-agents-99991", "rubato-agents-99992"])
		fixture.setAlive(() => false)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(2)
		expect(fixture.killed).toEqual(["rubato-agents-99991", "rubato-agents-99992"])
	})

	it("#given suffixed sessions with dead PIDs #when sweep called #then they are also killed", async () => {
		// given
		fixture.setCandidates(["rubato-agents-99991-1", "rubato-agents-99992-abc123"])
		fixture.setAlive(() => false)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(2)
		expect(fixture.killed).toEqual(["rubato-agents-99991-1", "rubato-agents-99992-abc123"])
	})

	it("#given session matches current PID #when sweep called #then it is NOT killed", async () => {
		// given
		fixture.setCandidates([`rubato-agents-${fixture.deps.currentPid}`, "rubato-agents-99999"])
		fixture.setAlive(() => false)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(1)
		expect(fixture.killed).toEqual(["rubato-agents-99999"])
	})

	it("#given session PID is still alive #when sweep called #then it is NOT killed", async () => {
		// given
		fixture.setCandidates(["rubato-agents-88888"])
		fixture.setAlive((pid) => pid === 88888)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(0)
		expect(fixture.killed).toEqual([])
	})

	it("#given killSession returns false #when sweep called #then session is not counted toward killedCount", async () => {
		// given
		fixture.setCandidates(["rubato-agents-55555"])
		fixture.setAlive(() => false)
		fixture.killSessionMock.mockImplementation(async () => false)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(0)
		expect(fixture.killSessionMock).toHaveBeenCalledTimes(1)
	})

	it("#given non-matching sessions mixed in #when sweep called #then only supported rubato-agents session names are considered", async () => {
		// given
		fixture.setCandidates(["main", "rubato-agents-99999", "rubato-agents-99999-1-2", "other-session", "rubato-agents-abc"])
		fixture.setAlive(() => false)

		// when
		const result = await sweepStaleRubatoAgentSessionsWith(fixture.deps)

		// then
		expect(result).toBe(1)
		expect(fixture.killed).toEqual(["rubato-agents-99999"])
	})
})

describe("sweepTmuxSessionsWith", () => {
	let fixture: SweepFixture

	beforeEach(() => {
		fixture = createFixture()
	})

	it("#given custom predicate for team sessions #when shared sweep called #then only matching sessions are killed", async () => {
		// given
		fixture.setCandidates(["rubato-team-A", "rubato-team-B", "main", "rubato-agents-99999"])

		// when
		const result = await sweepTmuxSessionsWith(fixture.deps, {
			predicate: (sessionName) => sessionName.startsWith("rubato-team-"),
		})

		// then
		expect(result).toEqual(["rubato-team-A", "rubato-team-B"])
		expect(fixture.killed).toEqual(["rubato-team-A", "rubato-team-B"])
	})
})
