export const TEAM_REPORT_REMINDER_TYPE = "senpi-task:team-report-reminder"

export const TEAM_REPORT_REMINDER_CONTENT =
  "The lead does not see this session. If this turn produced an outcome, team_send it to the lead, then end your turn."

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
