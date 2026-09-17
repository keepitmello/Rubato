import { describe, expect, test } from "bun:test"

import { createReportReminder } from "./report-reminder"

function harness() {
  const injected: number[] = []
  const reminder = createReportReminder(() => injected.push(injected.length + 1))
  return { reminder, injected }
}

describe("createReportReminder", () => {
  test("#given a turn with no team_send #when it settles #then it injects once", () => {
    const h = harness()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    expect(h.injected).toEqual([1])
  })

  test("#given a turn that sent #when it settles #then it does not inject", () => {
    const h = harness()
    h.reminder.onTurnStart()
    h.reminder.onTeamSend()
    h.reminder.onTurnSettled()
    expect(h.injected).toEqual([])
  })

  test("#given a reminder already fired #when new inbound work settles without a send #then it injects again", () => {
    const h = harness()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    h.reminder.onInboundWork()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    expect(h.injected).toEqual([1, 2])
  })

  test("#given a send after a reminder #when a later turn forgets to send #then it injects again", () => {
    const h = harness()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    h.reminder.onTurnStart()
    h.reminder.onTeamSend()
    h.reminder.onTurnSettled()
    h.reminder.onTurnStart()
    h.reminder.onTurnSettled()
    expect(h.injected).toEqual([1, 2])
  })
})
