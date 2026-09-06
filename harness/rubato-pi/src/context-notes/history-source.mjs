/**
 * Read the authoritative branch, not SessionManager.getBranch(). Senpi trims
 * its in-memory mirror after compaction and rewires retained parents there.
 * getEntries() explicitly loads full persisted history when that mirror was
 * trimmed. Following its original parent IDs preserves search and note scope.
 *
 * This baseline is O(history) on a changed leaf. An unchanged leaf is cached
 * by the controller. Do not optimize by substituting getBranch(): that loses
 * exactly the history these tools are intended to recover.
 */
export function readAuthoritativeBranch(manager) {
  if (typeof manager?.getEntries !== "function" || typeof manager?.getLeafId !== "function") {
    throw new Error("설치된 엔진에 전체 세션 기록을 읽는 인터페이스가 없어요.");
  }
  const all = manager.getEntries();
  if (!Array.isArray(all)) throw new Error("전체 세션 기록을 읽지 못했어요.");
  const byId = new Map();
  for (const entry of all) {
    if (entry?.type === "session") continue;
    if (typeof entry?.id !== "string" || !entry.id || byId.has(entry.id)) {
      throw new Error("세션 기록에 비어 있거나 중복된 식별자가 있어요.");
    }
    byId.set(entry.id, entry);
  }
  let id = manager.getLeafId();
  const seen = new Set();
  const branch = [];
  while (id) {
    if (seen.has(id)) throw new Error("세션 기록의 상위 항목이 순환해요. 문맥을 바꾸지 않았어요.");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error("세션 원본에서 상위 항목을 찾지 못했어요. 일부 기록을 누락시키지 않고 멈췄어요.");
    if (entry.type !== "session") branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}
