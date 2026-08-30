/**
 * 지난 세션이 남긴 `unknown` server-driven tool call 을 사용자에게 알린다.
 *
 * journal 은 `executing` 중에 죽은 호출을 `unknown` 으로 정착시키고 자동 재실행하지
 * 않는다. 그 판정 자체는 정확하지만, 그것만으로는 **아무도 모른다**: 같은
 * `toolCallId` 가 우연히 재전달될 때까지 그 사실이 보이지 않았다. 재전달이 없으면
 * 사용자는 파일을 하나 썼는지 안 썼는지 모르는 상태로 다음 턴을 시작한다.
 *
 * 그래서 세션이 시작할 때 한 번 읽어 한 줄로 말한다. 겁주지 않는다 — 어떤 도구였고
 * 실행 여부를 알 수 없다는 사실만 적는다. 사용자가 확인할지 말지 결정할 근거가
 * 그것으로 충분하고, 그 이상은 우리가 모르는 것이다.
 *
 * 정착은 알림과 **같은** 잠금 안에서 한다. `unresolved()` 만 부르면 아직
 * `executing` 인 항목은 보이지 않고, 정착은 다음 `prepare()` 때까지 미뤄진다.
 * 그 사이에 도구 호출이 없으면 사용자는 영원히 듣지 못한다. 살아 있는 PID 가
 * 쥔 항목은 정착하지 않는다 — 그건 다른 프로세스가 지금 실행 중인 것이다.
 */
import { pathToFileURL } from "node:url";
import { senpiDir } from "./engine-paths.mjs";
import { join } from "node:path";

/** 설치본 journal 모듈. bare import 는 깨끗한 설치에 없다. */
async function loadJournalModule() {
  return await import(pathToFileURL(join(senpiDir, "dist", "core", "cursor-exec-journal.js")).href);
}

/**
 * 미해결 항목이 있으면 한 줄을 돌려주고, 없으면 `undefined`.
 *
 * 실패를 던지지 않는다. journal 을 읽지 못하는 것은 알림을 못 내는 것이 아니라
 * 알림의 대상이다 — 실행을 막는 판정은 여전히 bridge 에 있고, 여기서는 그 사실을
 * 한 줄로만 말한다.
 */
export async function cursorExecUnresolvedNotice({ load = loadJournalModule } = {}) {
  try {
    const journalModule = await load();
    const journal = journalModule.createCursorExecJournal();
    if (typeof journal.settleAndListUnresolved === "function") {
      const report = journal.settleAndListUnresolved();
      if (report?.unreadable === true) {
        return typeof journalModule.formatCursorExecUnreadableNotice === "function"
          ? journalModule.formatCursorExecUnreadableNotice(report.reason)
          : undefined;
      }
      return journalModule.formatCursorExecUnresolvedNotice(report?.unresolved ?? []);
    }
    // Older journal without the combined op: do not invent a second writer.
    const unresolved = journal.unresolved();
    return journalModule.formatCursorExecUnresolvedNotice(unresolved);
  } catch {
    return undefined;
  }
}

/**
 * `session_start` 에서 한 번 알린다.
 *
 * 세션당 한 번이다. 같은 프로세스가 여러 세션을 열면 각 세션이 자기 시작점에서 한 번
 * 보고, 같은 세션에서 두 번 보지 않는다.
 */
export function registerCursorExecNotice(pi, { notice = cursorExecUnresolvedNotice } = {}) {
  if (typeof pi?.on !== "function") return;
  const told = new Set();
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const key = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "";
    if (told.has(key)) return;
    told.add(key);
    const message = await notice();
    if (!message) return;
    // `info` 다. `warning` 은 사용자가 무언가를 잘못했다는 뜻으로 읽히고, 여기서
    // 잘못한 사람은 없다 — 프로세스가 죽었을 뿐이다.
    ctx?.ui?.notify?.(message, "info");
  });
}
