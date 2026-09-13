# CP4b — T3 실제 제공자 계약

T3의 ProviderDriver, ProviderInstance, ProviderAdapterShape, ServerProviderShape와 실제 Effect 4.0.0-rc.112를 사용한 `RubatoPiDriver.ts`를 추가했다. 이는 T3 저장소에 적용할 원본 상대 경로를 유지한 overlay 파일이다. 등록 및 대화 목록 동기화는 다음 체크포인트다.

2026-09-13 Linux/Node 24.20.0에서 실제 T3 소스에 이 파일을 복사하고 strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess를 켜서 TypeScript 7.0.2 형 검사를 실행했다. 종료 코드 0이었다. 전체 T3 앱 빌드 검사가 아니라 새 제공자와 연결된 실제 형 선언 그래프의 검사다.

T3_SOURCE를 실제 T3 소스 경로로 설정하고 `node --test --test-timeout=45000 harness/t3-integration/test/*.test.mjs`를 실행했다. 총 5개 통과, 실패/취소/건너뜀 0, 종료 코드 0, 3029.095879ms였다. 새 검사는 실제 Driver factory를 Scope에서 만들고 ServerProvider/ProviderSession/ProviderTurnStartResult 계약으로 값을 검사한다. Scope 종료나 stopSession이 외부 Pi 작업을 종료하지 않는 것을 확인했다.

T3 재시작용 promptless continuation은 새 입력 전송이 아니라 이미 진행 중인 Pi 턴의 재연결이다. 실행 중인 턴이 없으면 명시적으로 거부한다. 실제 저장된 사용자 메시지 수가 재시작용 호출 전후 같고 runtimeId도 같은 것을 검사했다. 모델 및 에이전트 작업은 명시적인 시험용 child이며 공식 Pi 서버, 소켓, 실제 SDK 저장, T3 계약과 제공자 코드는 실제다.

모델 목록 조회만으로 인증 완료를 표시하지 않는다. T3의 실행 환경 변수는 독립 Rubato 서버에 적용할 수 없으므로 조용히 무시하지 않고 구성 오류로 처리한다. 자동 커밋 메시지/제목 생성과 되감기는 지원하지 않는 기능으로 표시한다.
