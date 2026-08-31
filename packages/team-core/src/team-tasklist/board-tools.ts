export const TEAM_TASK_CREATE = "team_task_create"
export const TEAM_TASK_LIST = "team_task_list"
export const TEAM_TASK_GET = "team_task_get"
export const TEAM_TASK_UPDATE = "team_task_update"

export const TEAM_BOARD_TOOL_NAMES = [
  TEAM_TASK_CREATE,
  TEAM_TASK_LIST,
  TEAM_TASK_GET,
  TEAM_TASK_UPDATE,
] as const

export type TeamBoardToolName = (typeof TEAM_BOARD_TOOL_NAMES)[number]

export const TEAM_BOARD_TOOLS = [
  {
    name: TEAM_TASK_CREATE,
    label: "Team Task Create",
    description:
      "Create a team work-board item (starts pending). This records work on the shared board; it does not start an Agent session. Use Agent to spawn a child model session.",
  },
  {
    name: TEAM_TASK_LIST,
    label: "Team Task List",
    description:
      "List team work-board items, optionally filtered by status (pending, claimed, in_progress, completed, deleted) or owner. Agent session state lives in AgentOutput, not on this board.",
  },
  {
    name: TEAM_TASK_GET,
    label: "Team Task Get",
    description:
      "Read one team work-board item by id; returns not_found if absent. The task_id is a board id, not an Agent session agentId. Use AgentOutput for child Agent sessions.",
  },
  {
    name: TEAM_TASK_UPDATE,
    label: "Team Task Update",
    description:
      "Update a team work-board item's status. Transitions run pending -> claimed -> in_progress -> completed, with deleted allowed from any state; status='claimed' claims it for owner (defaults to the lead). Illegal moves return already_claimed, blocked_by, invalid_transition, or cross_owner. This updates board work, not Agent session lifecycle (AgentSend / AgentCancel).",
  },
] as const
