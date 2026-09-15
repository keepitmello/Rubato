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
    if (typeof entry?.id !== "string" || !entry.id) {
      throw new Error("세션 기록에 비어 있는 식별자가 있어요.");
    }
    if (byId.has(entry.id)) {
      throw new Error(`세션 기록에 중복된 식별자가 있어요: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  let id = manager.getLeafId();
  const seen = new Set();
  const branch = [];
  // 끊긴 자리는 사람이 파일을 직접 걸어서 찾아야 했다. 어떤 항목이 누구를 가리키다
  // 멈췄는지 문구에 남긴다. 디스크가 찬 순간 부모가 기록되지 못하고 그 실패를 적은
  // 자식만 남으면 이 자리에서 대화가 통째로 잠긴다.
  let child;
  while (id) {
    if (seen.has(id)) throw new Error(`세션 기록의 상위 항목이 순환해요: ${id}. 문맥을 바꾸지 않았어요.`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) {
      const from = child ? ` ${child.id} 이 가리키는 자리예요.` : " 마지막 항목이 가리키는 자리예요.";
      throw new Error(`세션 원본에서 상위 항목 ${id} 을 찾지 못했어요.${from} 일부 기록을 누락시키지 않고 멈췄어요.`);
    }
    if (entry.type !== "session") branch.push(entry);
    child = entry;
    id = entry.parentId;
  }
  return branch.reverse();
}
