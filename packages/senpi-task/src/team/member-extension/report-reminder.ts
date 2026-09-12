export const TEAM_REPORT_REMINDER_TYPE = "senpi-task:team-report-reminder"

export const TEAM_REPORT_REMINDER_CONTENT =
  "The lead does not see this session. If this turn produced an outcome, persist it on the artifact or board and team_send affected peers. team_send the lead only when a shared contract changed or the batch is closed, then end your turn."

export type ReportReminder = {
  onTeamSend(): void
  onInboundWork(): void
  onTurnStart(): void
  onTurnSettled(): void
}

// One reminder per idle streak without team_send. A successful send or new inbound work
// opens the next streak; repeating settled without a send does not.
export function createReportReminder(inject: () => void): ReportReminder {
  let sentThisTurn = false
  let reminded = false
  return {
    onTeamSend() {
      sentThisTurn = true
      reminded = false
    },
    onInboundWork() {
      reminded = false
    },
    onTurnStart() {
      sentThisTurn = false
    },
    onTurnSettled() {
      if (sentThisTurn || reminded) return
      reminded = true
      inject()
    },
  }
}
