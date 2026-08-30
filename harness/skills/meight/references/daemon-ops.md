# 데몬 운용

meight 런타임 코드는 장수 데몬 프로세스에 로드된다. `meight.py`를 고쳤으면 새 워커의 동작을 믿기 전에 데몬을 재시작한다.

## epoch 마이그레이션과 재시작 후 스모크

살아있는 턴이 있는 레포 네임스페이스가 하나라도 있으면 재시작하지 않는다. 최종 `QUESTION:` 행은 dormant이고 재시작을 견디며 막지 않는다. 이 체크리스트는 오퍼레이터가 수동으로 수행한다. (현재 epoch: `ephemeral3`.)

1. `meight list --all-repos --json`으로 `starting`/`running`이거나 tool/approval 요청을 기다리는 행이 없는지 확인.
2. 비강제 `meight shutdown` 실행. 데몬 전역 active-session 가드가 drain 체크에서 놓친 게 있으면 shutdown을 거부해야 한다. 이 마이그레이션에 `--force`는 쓰지 않는다.
3. LaunchAgent 상태로 분기. 로드돼 있으면 `meight launchd install --load`를 쓰고 bounded `bootout --wait` 소유권 이전을 확인. 로드 안 돼 있으면 데몬을 평소대로 기동.
4. `meight ping` 실행 → `capabilities=ephemeral3` 확인, 새 데몬 PID와 소켓 정체성 확인.
5. 버리는 `--mode worker` 스모크 하나 (brief에 read-only 지시). status의 mode와 `meight-worker` + common preamble 경로 확인.
6. 버리는 `--mode mate` 스모크 하나. status mode `mate`와 `meight-mate` + common preamble 경로 확인.
7. 그다음에야 실제 작업을 디스패치. 버린 디스크 아티팩트는 평소 오퍼레이터 정책대로 지우거나 남긴다 — 강제 정리는 필요 없다.

## 점검 커맨드

```bash
MEIGHT_HOME="${MEIGHT_HOME:-$HOME/.meight}" meight ping
ps eww -axo pid,ppid,command | rg 'meight.py daemon|MEIGHT_IDLE_TIMEOUT_SEC|XPC_SERVICE_NAME=com.keepitmello.meight'
launchctl print "gui/$(id -u)/com.keepitmello.meight"  # LaunchAgent가 설치돼 있으면
meight list --all-repos --json
```

`meight ping`은 `session_retention_sec`도 노출한다.

## 경계와 보안 자세

- 워커 이름은 CLI와 데몬 양쪽에서 1-128자 ASCII 문자/숫자/`._-`로 제한되고 문자나 숫자로 시작해야 한다.
- 데몬은 레포 상태를 독립적으로 도출/검증하고, owner-only 상태 디렉토리와 `0600` 소켓을 쓰고, 워커 상태 symlink를 거부하고, 소켓 요청 하나를 1 MiB로 제한한다.
- 프로세스 전역 umask는 의도적으로 설정하지 않는다 — Codex 워커가 만드는 레포 파일 모드를 바꾸게 되기 때문이다.

## LaunchAgent

LaunchAgent가 로드돼 있으면 on-demand 기동은 `-k` 없는 `launchctl kickstart`를 쓴다. 직접 detached 기동은 job이 로드 안 됐을 때의 폴백일 뿐이다.

`meight launchd install --load`가 안전한 이전을 소유한다: 비강제 drain 요청 → active 세션 있으면 거부 → 확인된 옛 PID/소켓이 사라질 때까지 bounded 대기 → 로드된 job이면 subprocess timeout 걸고 `launchctl bootout --wait` → 새 plist bootstrap → 신선한 ping/PID + 소켓 정체성 요구, PID는 launchd의 running job과 일치해야 한다. `launchctl` 소유권이 모호하거나 unhealthy한 owner가 싱글턴 락을 쥐고 있으면 fail closed. 발행된 소켓이 삭제/교체되면 데몬은 launchd 복구를 위해 nonzero로 종료한다. drain 전에 수동으로 bootout하지 않는다.

LaunchAgent 감독은 crash-only다 (`RunAtLoad=true`, `KeepAlive={SuccessfulExit=false}`): 예기치 않은 accept 실패는 nonzero 종료 후 재시작하고, 확인된 clean shutdown은 zero로 종료하고 멈춘 채로 있는다.

## Non-persisted-session 불변식

- 모든 새 워커는 `status.json` / `meight status <name> --json`에 `"thread_source": "subagent"`와 `"thread_ephemeral": true`를 가져야 한다.
- `thread_source`는 analytics 메타데이터일 뿐이다. Codex Desktop 기록 누적을 막는 불변식은 `thread_ephemeral=true`다.
- Codex Desktop에 새 meight 워커가 예기치 않게 보이면, 다른 home이나 프로세스에서 도는 옛 데몬 또는 옛 epoch를 의심한다.

## 상태 경로와 수명주기

- 워커 아티팩트: `<daemon-home>/repos/<repo-key>/workers/<name>/{brief.md,status.json,events.log,result.md}`
- 저수준 커맨드: daemon / result / list / shutdown `[--force]` / launchd. 세션을 여는 공개 표면은 `dispatch`다.
- 포그라운드 `MEIGHT_IDLE_TIMEOUT_SEC` 기본값은 1800s이고 `daemon --idle-timeout-sec 0`이 끈다. 관리형 `dispatch`/LaunchAgent 기동은 idle disable을 env와 daemon args 양쪽으로 넘긴다. LaunchAgent job은 옛 로드 job에 env가 없으면 `XPC_SERVICE_NAME=com.keepitmello.meight`로 관리형 모드를 추론한다. 실제 값은 `meight ping`/기동 로그를 믿는다.
- Terminal 워커는 스트림 종료 직후 SDK 런타임을 놓는다. `MEIGHT_WORKER_GC_TTL_SEC`(기본 3600s)는 데몬 메모리에서 terminal 워커 상태만 제거한다. 디스크 아티팩트는 `MEIGHT_SESSION_RETENTION_SEC`(기본 30일, `0`이면 비활성)를 쓴다.
- 기본 `status`/`list`는 active와 종료 6시간 이내 행만 보여준다. 더 오래된 terminal 행은 논리적 archive이며 `--archived`로 따로, `--all`로 합쳐서 본다. 파일을 옮기지 않으므로 이름을 지정한 `status`/`result`/`follow`는 그대로 작동한다.
- 오프루프 시간별 cleanup은 immutable `terminal_at`(레거시 폴백 `updated_at`)로 유효한 만료 terminal 행만 정리하고, registry lock 아래서 원자적으로 tombstone한 뒤 lock 밖에서 삭제한다. 복구는 tombstone 접두사만 믿지 않고 terminal 상태·만료·registry 소유권을 다시 확인한다. active/replyable, malformed, symlink, registered 세션은 건너뛴다.
- 기동 시 고아 live 행은 `failed`/`runtime_lost_detail`로 전환된다. 최종 질문과 terminal 워커는 저장된 brief·result·recent events의 bounded handoff로 계속할 수 있다.
- SDK (`openai-codex==0.144.4`, 핀 고정): 업그레이드하면 SPEC.md 검증 스위트를 다시 돌린다.
- 소스와 문서: README.md, SPEC.md, ARCHITECTURE.md.
