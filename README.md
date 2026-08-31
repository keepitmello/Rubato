# Rubato

**빠르고 가볍게 매일 쓰는 멀티모델 에이전트 하네스.**

Rubato는 Claude Code나 Codex보다 빠르고 가볍게 움직이면서 컨텍스트 창은 더 천천히 채우고,
복잡한 작업은 역할과 모델을 나눠 더 안정적으로 끝낸다. 설치 부담이 작고 세션을 오래 써도
둔해지지 않아 매일 쓰기 편하다.

이름은 *tempo rubato*("훔친 시간")에서 왔다. 하네스가 박자를 강제하는 대신 모델이
문제에 맞게 생각할 시간을 조절한다.

## 무엇이 다른가

- **낮은 오버헤드** — 세션 시작과 일상적인 도구 호출이 빠르다.
- **느린 컨텍스트 소모** — 필요한 근거만 대화에 남기고, 오래 쓸 정보는 검색 가능한 기억으로 분리한다.
- **작업 중심 분업** — 리드가 방향을 잡고, 독립된 작업은 알맞은 모델에 맡기며, 결과는 별도로 검증한다.
- **멀티모델 직결** — Codex, xAI, Anthropic, Kiro, Antigravity, Cursor 모델을 한 세션에서 고른다.
- **한 저장소 설치** — 엔진, 프롬프트, 도구, 스킬과 업데이트 경로를 이 저장소에서 함께 관리한다.

## 설치

요구 사항은 Node 24+와 bun 1.4+다.

```bash
git clone --branch rubato/base https://github.com/keepitmello/Rubato.git
cd Rubato
./install.sh          # 바뀔 내용을 먼저 확인한다
./install.sh --apply  # 설치하고 모델 연결까지 확인한다
```

설치 프로그램은 기존 credential을 복사하거나 새로 만들지 않는다. 연결 상태는 설치 후
`rubato auth`로 확인한다.

## 자주 쓰는 명령

```bash
rubato                # 새 세션
rubato update         # 변경 내용을 확인하고 업데이트
rubato update --check # 업데이트 유무만 확인
rubato build          # 시스템 프롬프트와 엔진 산출물을 다시 빌드
rubato auth           # provider 연결 상태 확인
rubato aside-cursor --install  # Aside Cursor 면 (127.0.0.1:18788)
```

## iPhone에서 원격 사용

Rubato Remote는 같은 Tailscale tailnet의 Mac에서 세션을 실행하고 iPhone PWA에서
대화, 모델·명령 선택, 파일과 변경점 확인, 알림, 비상 터미널을 제어한다.

- [설치부터 iPhone 확인까지 따라 하는 테스트 절차](scripts/remote-release/USER-TEST.md)
- [릴리스 빌드·업데이트·삭제 운영 문서](scripts/remote-release/README.md)

## 더 보기

- [하네스 사용법과 운영 구조](harness/README.md)
- [Aside](harness/aside-cursor.md)
