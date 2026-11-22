import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

const route = "/rubato/push";
const subject = "notification settings";

export const rubatoPush = {
  status: (env: EnvironmentId) =>
    postRubato<{ desktopCompanionThreads: boolean }>(env, route, "status", {}, subject),
  setDesktopCompanionThreads: (env: EnvironmentId, enabled: boolean) =>
    postRubato<{ enabled: boolean }>(env, route, "desktop-companion-threads", { enabled }, subject),
  desktopThreadMuted: (env: EnvironmentId, threadId: ThreadId) =>
    postRubato<{ muted: boolean }>(env, route, "desktop-thread-muted", { threadId }, subject)
      .then(({ muted }) => muted, () => false),
};
