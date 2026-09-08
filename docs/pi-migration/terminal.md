# Stock Pi terminal/PTTY 이관 경계

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

결론: persistent terminal은 stock Pi의 one-shot bash로 대체할 수 없다. 이 feature는
Senpi terminal builtin의 실행 source 30개와 stock host adapter 5개를
`features/terminal/src`에 소유하고, 독립 `@code-yeongyu/senpi-pty@2026.9.4-3`를
사용한다. 여섯 도구(`bash`,
`bash_input`, `bash_output`, `bash_resize`, `kill_bash`, `monitor`)뿐 아니라 screen model,
session registry, monitor, notification, reload park/rebind, manifest/lease graph를 함께
보존해야 한다.

## PTY provenance

- npm package: `@code-yeongyu/senpi-pty@2026.9.4-3`
- npm SRI: `sha512-MBsavWt2Av+OCes/Gdy2YCLM5llXxKnoC6OiQaiqgQZv6ayDI0EGaCAyiftKlXsW3Jg/+Obt53mlpbzkGEog4A==`
- official repository/tag: `https://github.com/code-yeongyu/senpi`, `v2026.9.4-3`
- tag commit: `b0a446488dafc813ec2ff56e515668c0fa990027`
- root license: MIT, SHA-256
  `b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`
- transitive screen parser: `@xterm/headless@6.0.0`

공개 tag에는 `packages/pty/src` 전체와 `crates/senpi-pty`의 Rust/Cargo source, tests,
MIT LICENSE/NOTICE가 있다. tag의 package prebuild, crate prebuild, npm tarball에 설치된
`native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`는 모두 SHA-256
`20f9f1644966694779ee78b76cf60e9f2de2ae0b373a1eb0cf5944afdda0c4da`로 동일하다.
따라서 npm tarball이 Rust source와 LICENSE 원문을 싣지 않은 것은 provenance 부재가 아니라
배포 포장 누락이다.

현재 prebuild는 Mach-O arm64이고 adhoc linker signature이며 TeamIdentifier가 없다.
시스템 `libiconv.2.dylib`, `libSystem.B.dylib`에 링크한다. 다른 OS/arch prebuild와
Developer ID 서명·공증 증거는 아직 없으므로 현재 지원 증거는 macOS arm64에 한정한다.

## 실제 macOS arm64 증거

```text
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  node --test --test-timeout=40000 \
  harness/pi-runtime/features/terminal/terminal-native.test.mjs \
  harness/pi-runtime/features/terminal/terminal.test.mjs

3 tests, 3 pass
```

이 검증은 pipe fallback이 아니라 loader의 quarantine 검사와 ABI sentinel을 통과한 native
backend를 사용한다. direct native test에서 persistent shell 값 `41 -> 42`, delta output,
xterm screen `80x24 -> 100x31`, graceful exit와 캡처 shell PID 소멸을 확인했다.

통합 test는 clean runtime에 descriptor의 37개 file을 stage하고, stock
`DefaultResourceLoader`/`AgentSession`에 terminal factory와 generic `executeTool`을 실제로
bind한다. 여섯 도구가 모두 등록·활성화된 상태에서 다음 경로를 실행했다.

1. background `bash`를 열어 `bash_input`으로 값을 설정하고 `bash_output`으로 읽음
2. stock `session.reload()`에서 bundle을 park/claim한 뒤 같은 `bash_id`와 값 `42`를 읽음
3. native PTY와 xterm screen을 `100x31`로 resize하고 screen view로 실제 크기를 읽음
4. interactive shell에 `exit`를 보내 캡처 PID 소멸을 확인
5. one-shot command `monitor`를 등록·호출하고 monitor shell PID의 자연 종료를 확인
6. descendant가 없는 `exec sleep 60` 세션을 `kill_bash`로 중단하고 캡처 PID 소멸을 확인

모두 빈 임시 cwd/HOME와 주입한 in-memory settings를 썼고 profile/provider에는 접근하지
않았다. test cleanup도 생성 때 캡처한 PID만 대상으로 하며, 살아 있으면 SIGKILL 후 소멸을
기다린다.

## upstream baseline에서 분리한 종료 결함

interactive bash 아래 background `sleep`을 띄우면 job-control이 별도 process group을 만든다.
동일한 command/session 옵션으로 runtime-owned manager와 원래 설치된 Senpi manager를 좁게
A/B한 결과가 같았다.

| 구현 | `manager.stop()` | stop 뒤 shell | stop 뒤 background `sleep` |
| --- | ---: | --- | --- |
| runtime-owned | 5001ms | group 91641 alive | pid/group 91642 alive |
| original Senpi | 5001ms | group 92284 alive | pid/group 92286 alive |

첫 SIGTERM을 interactive bash가 무시할 수 있는데 `TerminalSession`은 뒤의 kill을 idempotent로
처리한다. 첫 신호를 SIGKILL로 바꾼 별도 probe에서도 background job의 다른 group은 남았다.
A/B가 만든 네 PID는 각각의 생성 receipt로만 SIGKILL하고 모두 `gone`을 확인했다. 이 결과는
이번 stock Pi adapter가 새로 만든 회귀가 아니라 published Senpi/PTTY baseline의 기존
descendant lifecycle 결함임을 뜻한다.

## 아직 닫히지 않은 경계

- `kill_bash`의 단일 process-group 종료는 통과했지만 descendant tree-kill과 전체 shutdown
  무고아 계약은 위 baseline 결함 때문에 미완료다. 현재 native API는 shell PID/descendant
  inventory를 공개하지 않는다. 이를 닫으려면 native source에서 descendant를 신호 전에
  열거·종료하고 Darwin arm64 binary를 재현 빌드하거나 upstream fixed artifact가 필요하다.
- Linux/Windows/Bun terminal backend는 이 host에서 실행하지 않았다.

따라서 현재 증거는 **runtime-owned source/adapter와 MIT/native provenance, stock SDK 실제
binding, 여섯 도구 호출, native persistence/screen/resize/reload park-rebind, graceful 종료와
단일-process kill**까지다. descendant가 있는 종료와 다른 OS를 통과하기 전에는 terminal
전체 parity나 shutdown 무고아를 주장하면 안 된다.
