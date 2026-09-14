# 공통 엔진 운영과 검증

2026-09-15. CLI와 GUI는 기존 사용 방식을 유지하고 **같은 프로필의 엔진 하나**를 공유한다. Codex 구현을 복제하거나 Codex 엔진으로 교체한 것은 아니다.

현재 설치 전환 완료: Node24.18.0 / Pi0.85.1 / 45-feature build. 2026-09-15 07:54 KST에 시작한 공통 엔진을 실제 CLI5개와 T3 bridge가 공유하는 것을 확인했다. 기존 저장 대화483개와 원본 파일893개는 byte/hash 비교로 보존을 확인했고, 인증·설정·모델·신뢰 설정도 그대로다. 검증용 기록6개는 원래 목록에서 분리해 백업에 보관했다. 앱은 다시 열어 기존 목록을 확인했고 허브는 유지했다.

설치 source fingerprint: `c3f89f5aa2d4e06aa21654fd664a64d99be24887fc071248abe970d0eb778b0b`. 직전43-feature 설치는 `stock-engine.previous`에 있다. 데이터 백업은 `~/.rubato-pi/backups/common-engine-2026-09-14T22-51-41-683Z/`이며 일반 저장소/원격 Git에는 넣지 않는다.

```text
CLI 창 ─ zmx ─ 얇은 터미널 client ─┐
CLI 창 ─ zmx ─ 얇은 터미널 client ─┼─ profile Pi Server
T3 앱 ─ 기존 Rubato driver ────────┘    ├─ SDK 대화 A + JSONL A
                                       ├─ SDK 대화 B + JSONL B
                                       └─ SDK 대화 C + JSONL C
```

- 엔진: 공식 Pi Server/SessionRouter를 사용하고 대화별 SDK actor를 소유한다. 프로필이 다르면 엔진도 별도다.
- CLI: native Pi TUI가 엔진 안에서 렌더링하고 client는 터미널 입출력·크기·신호·외부 편집기 연결만 담당한다. 기존 명령을 축약 RPC로 재구현하지 않는다.
- GUI: 기존 driver가 같은 descriptor로 연결한다. 별도의 GUI용 Pi 엔진을 띄우지 않는다.
- 허브/zmx는 유지한다. 창별 hub identity/token은 terminal presentation에 속한다. `/new`·`/resume` 시 연결을 새 actor로 다시 묶고, GUI actor나 다른 창으로 전파하지 않는다.
- extension startup은 actor마다 한 번만 실행한다. 화면 재연결은 별도의 내부 presentation-bind 이벤트이며 startup을 반복하지 않는다.
- 각 대화는 하나의 JSONL writer와 CLI 제어권 하나를 갖는다. 같은 대화를 CLI가 제어할 때 GUI는 관찰만 가능하다. 서로 다른 대화의 동시 진행은 가능하다.
- 닫힌 terminal은 SDK 프로세스를 종료하지 않는다. 진행 중인 대화는 유지하고 미연결·유휴 actor는 기본 60초 뒤 회수한다. 질문을 기다리던 도구는 질문 취소를 먼저 전달한 뒤 종료를 기다린다.
- theme/키보드/HTTP·인증 환경/cwd는 소유 scope로 분리한다. 임의 외부 extension의 전역 변수까지 자동으로 안전해지는 것은 아니다.
- 모델 API, MCP·실제 도구 및 명시적 작업 worker의 자식 프로세스는 별도로 존재할 수 있다. 목표는 모든 OS 프로세스를 하나로 만드는 것이 아니라 전체 엔진의 대화별 중복을 없애는 것이다.

## 전환 조건

1. `SessionClient.list()`에서 진행 중·질문 대기·연결된 actor를 확인한다. 활성 작업이 있으면 강제로 갈아끼우지 않는다.
2. 원본 `agent/sessions`, 인증·설정, T3 SQLite를 백업하고 사본을 검증한다. SQLite는 online backup을 사용한다.
3. T3를 정상 종료하고 **확인된 해당 프로필 서버 PID만** 종료한다. 허브나 다른 프로필은 함께 종료하지 않는다.
4. Node24로 공식 installer를 실행한다. 예:

   ```sh
   node harness/pi-runtime/scripts/install-candidate.mjs \
     --output "$HOME/.rubato-pi/stock-engine" --update
   ```

   임시 디렉터리에서 pinned npm 설치·빌드·검증 후 원자적으로 교체한다. 기존 설치는 `stock-engine.previous`에 남는다. `rubato-install.json`의 `state:ready`, source fingerprint, `session-ui`·`session-transport`를 확인한다.
5. T3를 다시 열고 기존 서버 소켓 외에 `terminalSocketPath` 및 설치본 `runtimeRoot`가 descriptor에 들어왔는지 확인한다. 기존 대화 수·내용을 비교한다.
6. 실제 `rubato new/attach`, 새 대화·재개 및 T3 driver가 같은 서버에 연결되는지 확인한다. 설치 전 후보 시험과 설치 후 검증을 구분한다.

대화가 없는 구형 서버라도 launcher가 자동으로 죽이거나 두 번째 엔진을 만드는 일은 없다. 구형 실행본 발견 시 명시적인 재시작 안내를 내보낸다. T3 전체 재설치나 계정 재로그인은 필요하지 않다.

## 되돌리기

해당 프로필의 작업을 정상 종료한 뒤 다음을 실행하고 T3/프로필 서버를 다시 시작한다.

```sh
node harness/pi-runtime/scripts/install-candidate.mjs \
  --output "$HOME/.rubato-pi/stock-engine" --rollback
```

이 명령은 바로 직전의 검증된 설치 디렉터리를 복원한다. JSONL을 롤백하거나 인증을 덮지 않는다. 되돌린 후에도 descriptor와 저장 목록을 재확인한다. 정상으로 판단하기 전에는 백업을 지우지 않는다.

## 근거와 제한

최종 후보20: 관리형 pane 2개와 실제 Unix hub 인증/명령, native 새 대화·재개·질문 응답·닫기/회수 통과. 같은 SDK를 유지하면서 새 pane으로 재연결해도 startup은 한 번이었다. CLI 실제 OS 프로세스 5개와 공식 GUI client는 같은 엔진 PID를 사용했다. 실제 SDK 동시 실행, headless/RPC/print, native 질문 중 종료, 화면 및 SDK weak-reference 회수도 통과했다. 관련 72개 검사와 자체 격리 native 검사 2개가 통과했다. 유료 모델 API는 호출하지 않았다.

동일 조건 자원 비교(후보16, 두 경로 모두 lazy AST, 단일 표본):

| 대화 수 | 독립 엔진 RSS 합계 | 공통 엔진+CLI RSS 합계 |
|---|---:|---:|
| 1 | 254MiB | 313MiB |
| 5 | 1,284MiB | 566MiB |

5개에서 약56% 감소, 1개에서는 얇은 client 비용으로 약59MiB 증가한다. 5초 안정화 후 10초 유휴 측정에서 고유 엔진 PID CPU 합계는 한 코어 기준6.32%→1.94%였다. RSS는 PSS/물리 메모리 보장이 아니고 CPU에는 frontend/도구 자식이 포함되지 않는다. 관리형 pane 연결 수정 뒤 자원 비율 자체는 재측정하지 않았다.

전체 legacy suite는 green이 아니다. 이전 광범위 검사의 38개 실패를 모두 baseline으로 입증한 것은 아니며, 전체 타입 검사에는 변경 전부터 확인된 오류3개가 남는다. 임의 외부 extension, 실제 유료 provider, 외부 편집기, 장기 실사용은 별도 미검증이다. `fullRubatoParity:false`를 유지한다.

원본 실험 로그와 명령: Rubato-lab `_workspace/runtime-architecture-20260915/`의 `common-cli-implementation.md`, `common-resource-final.md`, 후보20 `common-*.json`, `isolated-focused-20.txt`, `isolated-native-20.txt`. 관리형 회귀 fixture는 `harness/pi-server/test/fixtures/common-managed.mjs`에 있다. 일반 프로필이나 저장소 cwd에서 시험 fixture를 실행하지 않는다.
