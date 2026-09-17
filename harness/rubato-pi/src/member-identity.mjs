const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBER_NAME = /^[a-z0-9-]+$/;

function memberIdentityRaw(env = process.env) {
  return env.RUBATO_TASK_MEMBER || env.SENPI_TASK_MEMBER;
}

export function isTeamMemberProcess(env = process.env) {
  const raw = memberIdentityRaw(env);
  return Boolean(raw && raw.length > 0);
}

export function parseMemberIdentity(env = process.env) {
  const raw = memberIdentityRaw(env);
  if (!raw) return null;
  const [teamRunId, memberName] = raw.split("::");
  if (!teamRunId || !memberName || !TEAM_ID.test(teamRunId) || !MEMBER_NAME.test(memberName)) {
    return { kind: "member", teamRunId: null, memberName: null };
  }
  let config = {};
  const teamConfig = env.RUBATO_TASK_TEAM_CONFIG || env.SENPI_TASK_TEAM_CONFIG;
  if (teamConfig) {
    try {
      config = JSON.parse(teamConfig);
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
