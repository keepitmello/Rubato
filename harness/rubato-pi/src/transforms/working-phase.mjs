// 상태줄(working dock)이 지금 무엇을 하고 있다고 말할지 정하는 자리.
// 벤더는 턴이 시작되면 끝까지 "Working" 하나만 쓰고, 그 독을 agent_idle 까지
// 붙들고 있다. 그래서 (1) 사고와 실행이 구분되지 않고 (2) 답이 다 찍힌 뒤에도
// 세션 정리(제목 생성·확장 정산)가 끝날 때까지 "Working (Ns • esc to interrupt)"
// 가 계속 돌았다 — 실측 0.5s~3.9s. 여기서 그 둘을 모두 잡는다.

export function workingPhaseHref() {
  return import.meta.url;
}

export const THINKING_LABEL = "Thinking";
export const WORKING_LABEL = "Working";

/**
 * 스트리밍 중인 어시스턴트 메시지의 꼬리 블록으로 지금 국면을 읽는다.
 * 꼬리가 사고면 아직 생각 중이고, 말이나 도구가 나왔으면 일을 시작한 것이다.
 * 도구 결과 뒤에 다시 사고가 붙으면 자연히 Thinking 으로 돌아간다.
 *
 * @param {{ content?: ReadonlyArray<{ type?: string, text?: string }> }} [message]
 * @returns {"Thinking" | "Working" | undefined} 판단할 근거가 없으면 undefined
 */
export function nextWorkingLabel(message) {
  const content = message?.content ?? [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block) continue;
    if (block.type === "toolCall") return WORKING_LABEL;
    if (block.type === "text") {
      // 빈 텍스트 블록은 스트림이 방금 연 자리다. 아직 말이 시작된 게 아니므로
      // 그 앞의 사고 블록이 국면을 정한다.
      if (String(block.text ?? "").length > 0) return WORKING_LABEL;
      continue;
    }
    if (block.type === "thinking") return THINKING_LABEL;
  }
  return undefined;
}

/**
 * agent_end 에서 독을 접을지. 재시도가 예정돼 있으면 다음 런이 바로 이어지므로
 * 붙들고, 편집기에 들어와 대기 중인 입력이 있으면 그것도 곧 턴을 연다.
 *
 * @param {{ willRetry?: boolean }} [event]
 * @param {number} [pendingUserInputCount]
 */
export function shouldClearWorkingOnAgentEnd(event, pendingUserInputCount = 0) {
  if (event?.willRetry === true) return false;
  return pendingUserInputCount === 0;
}
