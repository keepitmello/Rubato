/**
 * 스톡 Pi 핀의 단일 출처. 정본 모듈은 payload 로 함께 실리는
 * `features/rubato-components/pi-version.mjs` 이고, 여기서는 그걸 재수출만 한다 —
 * staged 후보와 레포가 **같은 파일**을 쓰게 하려는 것이다. 사본을 두면
 * 후보에서 도는 핀과 레포가 도는 핀이 갈라진다.
 */
export { PI_VERSION } from "./features/rubato-components/pi-version.mjs";
