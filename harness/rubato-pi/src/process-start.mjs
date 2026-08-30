/**
 * 이 프로세스가 시작한 벽시계 시각. rubato-stream 이 timing 에 찍고, 상태줄과 tps 알림이
 * "이 값이 내 프로세스인가"로 옛 세션의 기록을 걸러낸다.
 *
 * `Date.now() - performance.now()` 를 부르는 쪽마다 새로 재면 같은 프로세스인데도 ±1ms
 * 흔들려 그 동등 비교가 산발적으로 어긋난다 (실제로 알림에서 delay 가 통째로 빠졌다).
 * 모듈 로드 시각에 한 번만 재고 모두가 같은 정수를 본다.
 */
export const PROCESS_STARTED_AT = Math.floor(Date.now() - performance.now());

export function processStartedAt() {
  return PROCESS_STARTED_AT;
}
