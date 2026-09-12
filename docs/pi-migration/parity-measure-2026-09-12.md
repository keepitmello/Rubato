# stock-pi 이미 이식된 5건 실측 (2026-09-12)

엔진: 설치본 `~/.rubato-pi/stock-engine` (stock-pi 0.85.1, tui-input/session-picker/remote-surface 포함).
스크래치 프로필: `/tmp/phase0a-parity-2026-09-12/profile` (auth.json만 복사). 캡처: `/tmp/phase0a-parity-2026-09-12/captures/`.
재현: `TERM=xterm-256color harness/scripts/rubato-pi.sh direct --offline --no-skills --no-context-files` + 더미 `RUBATO_HUB_SOCKET` (라이브 허브에 붙지 않게).

판정은 보수적이다. 라이브 화면과 스테이징 native PTY를 구분했다.

## 판정표

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| A1 한글 stdin 조립 | 된다 | 설치본 `pi-tui/dist/stdin-buffer.js`에 StringDecoder 패치가 있다. `features/tui-input/unicode-pty.test.mjs` native PTY가 한글 조합·3바이트 분할을 U+FFFD 없이 통과 (18/18, 그중 native PTY 1건). 런처 라이브 캡처 `hangul.txt`는 스킬 덤프와 겹쳐 `한글가` 전체가 안 보여 보조 증거로만 둔다. |
| A3 클립보드 이미지 | 된다 | factory와 interactive-mode가 같은 runtime 파일 `rubato-features/tui-input/images.mjs`를 본다 (dist 복사본 제거). 임시 엔진 Ctrl+V가 `[Image #1]`로 붙고 `pi-clipboard-` 경로는 없다 (`unify-clipboard.txt`). 고치기 전 캡처 `clipboard.txt`는 경로 fallback이었다. |
| busy-enter | 된다 | 같은 runtime `busy-enter.mjs`를 공유하고 pending display에 `BUSY_ENTER_STATUS`를 붙였다. 임시 엔진 실 스트리밍(`── Thinking`) 중 Enter가 `Follow-up: queued-followup-xyz`로 큐잉되고 `Enter 한 번 더 - 지금 작업에 바로 전달`이 보인다 (`unify-busy.txt`). Steering 라벨은 없음. |
| /resume 페이징 | 된다 | `session-picker.test.mjs` native PTY가 36건에서 첫 페이지·12건 단위 추가 로드·검색을 통과 (4/4, native PTY 1.07s). 라이브에서는 `/resume` 후 `Resume Session (Current Folder)`가 14.6ms에 떴다 (`resume.txt`). 같은 프로필의 합성 36건 본문(`picker-message-035`)은 25초 캡처에 안 남아 목록 본문은 이 레이아웃에서 미확인. |
| 부팅 splash 인계 | 된다 | 런처 캡처에 워드마크 → `엔진을 불러오는 중` → `화면을 여는 중`(`handoffBootChromeForStockPi` 전용) → `준비 완료` → stock 푸터(`claude-opus-5 • high`)가 이어진다. `boot-baseline.txt`. |

## 기준선 (수정 전)

| | |
| --- | --- |
| 캡처 | `/tmp/phase0a-parity-2026-09-12/captures/boot-baseline.raw` / `.txt` / `.err` |
| TUI | 7.1s에 준비. splash 인계 후 푸터 보임. |
| stderr nonempty | 15줄 (스택 포함) |
| remote-surface 오류 | 1건: `[rubato-remote-surface] start failed: Error: rubato-remote-protocol checkout was not found` (`protocol-loader.mjs:50`) |

## remote-surface 수정 후

설치본과 같은 조건(로더 상위에 체크아웃 없음)에서 동봉 `protocol.mjs`를 먼저 본다. 런타임 bun 없음.

| | |
| --- | --- |
| 재현 테스트 | `cd harness/pi-runtime && node --test features/remote-surface/protocol-loader.install.test.mjs` → 2/2 통과 |
| 후보 엔진 | `node harness/pi-runtime/build-candidate.mjs --output /tmp/phase0a-remote-surface-engine` |
| 번들 | `/tmp/phase0a-remote-surface-engine/rubato-features/remote-surface/protocol.mjs` (68924 bytes) |
| 로더 실측 | `resolve/load` source=`bundled`, `REMOTE_PROTOCOL_NAME=rubato.remote.v1` |
| 부팅 | `/tmp/phase0a-parity-2026-09-12/captures/candidate-boot2.txt` — TUI 1.2s, remote-surface 오류 줄 0, checkout-not-found 0 |

## tui-input 모듈 통일 (후속)

원인: factory는 `rubato-features/tui-input/*.mjs`, 패치는 `dist/rubato-features/tui-input/*.mjs`라 `enabled`가 갈라졌다.
수정: dist 복사본을 없애고 `interactive-mode.js`가 `../../../../../../rubato-features/tui-input/…`로 runtime 파일을 직접 import. pending 힌트에 상태줄 문구 추가.
후보: `/tmp/phase0a-tui-unify-engine`. 테스트: `cd harness/pi-runtime && node --test features/tui-input/tui-input.test.mjs features/tui-input/images.test.mjs` 16/16.

## 캡처 목록

- `boot-baseline.{raw,txt,err}` — 수정 전 부팅
- `hangul.{raw,txt,err}` — 라이브 한글 입력 시도
- `clipboard.{raw,txt,err}` — Ctrl+V 이미지
- `resume.{raw,txt,err}` — /resume 첫 페인트 14.6ms
- `resume2.{raw,txt,err}` — 목록 본문 25s 대기 (picker-message 미표시)
- `candidate-boot2.{raw,txt}` — 체크아웃 밖 후보 엔진 부팅
- `unify-clipboard.{raw,txt}` — 수정 후 Ctrl+V → `[Image #1]`
- `unify-busy.{raw,txt}` — 수정 후 스트리밍 Enter → Follow-up + 상태줄

삭제한 테스트: 없음.
