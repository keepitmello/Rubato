// 배경에서 도는 것들(셸 · 모니터)을 한 곳에 모은다.
//
// 엔진은 상태가 바뀔 때마다 `wake_source_state` 이벤트를 쏜다. source 로 갈리고
// 배열이 담긴 필드 이름만 다를 뿐, 항목은 모두 `{ id, description, startedAtMs }` 다.
// 그래서 여기서는 source 별 최신 스냅샷만 들고 있으면 된다 — 우리가 따로 시계를 굴리거나
// 시작 시각을 기록할 필요가 없다.
//
// 서브에이전트는 에디터 위 위젯이 그린다. footer 는 셸과 모니터만 남긴다.
import { BACKGROUND_SOURCES } from "./statusline.mjs";

const WAKE_SOURCE_STATE_EVENT = "wake_source_state";

/**
 * source 별 최신 스냅샷을 들고 있는 저장소. `groups()` 가 화면이 그릴 형태를 준다.
 */
export function createBackgroundTracker() {
  const bySource = new Map();
  return {
    /** 이벤트를 반영하고, 화면을 다시 그려야 하면 true. */
    accept(event) {
      const parsed = parseEvent(event);
      if (parsed === null) return false;
      const previous = bySource.get(parsed.source);
      if (sameEntries(previous, parsed.entries)) return false;
      bySource.set(parsed.source, parsed.entries);
      return true;
    },
    /** 지금 도는 게 하나라도 있나 — 없으면 타이머를 세울 이유가 없다. */
    active() {
      for (const entries of bySource.values()) {
        if (entries.length > 0) return true;
      }
      return false;
    },
    groups() {
      return new Map(bySource);
    },
    clear() {
      bySource.clear();
    },
  };
}

function parseEvent(event) {
  if (!event || typeof event !== "object") return null;
  const spec = BACKGROUND_SOURCES.find((candidate) => candidate.source === event.source);
  if (!spec) return null;
  const raw = event[spec.field];
  if (!Array.isArray(raw)) return { source: spec.source, entries: [] };
  const entries = raw
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      description: String(entry.description ?? entry.id),
      startedAtMs: Number(entry.startedAtMs),
    }));
  return { source: spec.source, entries };
}

/** 같은 스냅샷이 다시 오면 다시 그리지 않는다. */
function sameEntries(previous, next) {
  if (previous === undefined) return false;
  if (previous.length !== next.length) return false;
  return previous.every((entry, index) => {
    const other = next[index];
    return entry.id === other.id
      && entry.description === other.description
      && entry.startedAtMs === other.startedAtMs;
  });
}

export { WAKE_SOURCE_STATE_EVENT };
