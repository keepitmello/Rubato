const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBER_NAME = /^[a-z0-9-]+$/;

export function isTeamMemberProcess(env = process.env) {
  return Boolean(env.SENPI_TASK_MEMBER && env.SENPI_TASK_MEMBER.length > 0);
}

export function parseMemberIdentity(env = process.env) {
  const raw = env.SENPI_TASK_MEMBER;
  if (!raw) return null;
  const [teamRunId, memberName] = raw.split("::");
  if (!teamRunId || !memberName || !TEAM_ID.test(teamRunId) || !MEMBER_NAME.test(memberName)) {
    return { kind: "member", teamRunId: null, memberName: null };
  }
  let config = {};
  if (env.SENPI_TASK_TEAM_CONFIG) {
    try {
      config = JSON.parse(env.SENPI_TASK_TEAM_CONFIG);
    } catch {
      config = {};
    }
  }
  return {
    kind: "member",
    teamRunId,
    memberName,
    stateDir: typeof config.stateDir === "string" ? config.stateDir : null,
  };
}
