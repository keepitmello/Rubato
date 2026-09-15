# Stage 9 independent-leg verification record

Date: 2026-08-31

Host: macOS 26.5.2 (25F84), arm64; Node 26.5.0; Bun 1.4.0; Tailscale CLI 1.102.3 logged in and running. The real Serve configuration was `{}` before this work. No destructive Serve command was run.

The self-built PWA and the hub HTTP/WS surface recorded in the original live
qualification were later retired. The iPhone client is T3 Code. The hub unix
socket, zmx signing, and qualification driver evidence below still apply.

## Live installed qualification

Later on the same date, a trusted local qualification release was installed.
The hub LaunchAgent came up and a real managed session reached `lifecycle: "ready"`
at `/Users/wy/Rubato-remote-smoke` with the pinned Pi surface and model inventory.
The final root test, typecheck, build, build-check, release, notice, license, and
production-audit matrix ended with `FINAL_MATRIX_GREEN`; the audit checked 270
production packages with zero vulnerabilities.

## Commands and exit codes

| Command | Exit | Result |
|---|---:|---|
| `node --test scripts/remote-release/*.test.mjs scripts/license-policy.test.mjs scripts/check-third-party-notices.test.mjs packages/rubato-live-cli/test/*.test.mjs` | 0 | 50 release, zmx exact-manifest, license, notice, CLI routing, and isolated uninstall tests passed. |
| Symlinked-checkout `verify.sh` contract and `/Users/wy/Github-repos/rubato` real-path invocation | 0 | All five release wrappers resolve their main module through `pwd -P`; the verified local artifact emitted its bound build ID and source commit instead of silently exiting. |
| `bun test packages/rubato-remote-hub/test/path-security.test.ts packages/rubato-remote-hub/test/tickets-pairing.test.ts` | 0 | Path and pairing tests passed. |
| `bun test packages/rubato-terminal-bridge/test` | 0 | 25 passed, one installed-zmx smoke skipped because no pinned zmx is installed at the user path. |
| Signed one-time arm64 `build-zmx-release.mjs` followed by `smoke-zmx-release.mjs` | 0 | Exact commit `0266042...` built with Zig 0.16.0 ReleaseSafe, reported zmx 0.7.0, and produced a signed exact-byte manifest for this build only: 2,573,552 bytes, SHA-256 `bd409d56...`. Run/list/kill and PTY attach frame echo passed (128 bytes), with no leaked sessions. This transient hash was not written to the source lock. |
| One-time x86_64 cross-build, Rosetta run/list/kill, and Bun PTY attach smoke | 0 | The exact commit reported zmx 0.7.0; the tested one-time bytes had SHA-256 `bb4586be...`. PTY frame echo passed (65 bytes), with no leaked sessions. This evidence qualifies only those exact local bytes and is not a reproducible source hash. |
| `npm --prefix packages/rubato-remote-hub run typecheck` | 0 | Hub and added security test typecheck passed. |
| `npm --prefix packages/rubato-remote-hub run build` | 0 | Hub build passed. |
| `npm --prefix packages/rubato-live-cli run check` | 0 | CLI syntax checks passed. |
| `node harness/scripts/build-engine.mjs --check` | 0 | Existing Rubato build was current. |
| `bun test patch-tests` | 0 | 229 tests passed. (historical: patch-tests retired with the vendor patch overlay; the harness unit suite now carries these checks) |
| `node scripts/check-third-party-notices.mjs` | 0 | 29 required entries plus zmx/npm evidence passed. |
| `node scripts/check-third-party-notices.mjs --ship` | 0 | Two packaged NOTICE payloads passed dry-run verification. |
| `node scripts/license-policy.mjs` | 0 | All 780 registry packages in the current Bun lock were reviewed. |
| `bun audit --production` | 0 | 270 production packages checked; no vulnerabilities found. |
| Built-in qualification driver contract test plus short measured host profile | 0 | Message acknowledgements/order, event persistence, bounded 64 KiB streaming, reconnect/attach stable PID, restart recovery, cleanup, and explicit physical-device pending status passed. With `RUBATO_QUALIFICATION_ZMX` set to the one-time qualified local arm64 asset, the real run/list/kill driver test also passed. |
| `ruby -e 'require "yaml"; ... YAML.load_file ...'` over `.github/workflows/*.yml` | 0 | All four workflow files, including `zmx-release.yml`, parsed. |
| Local signed `buildRelease({ skipChecks: true, zmxManifestDirectory, ... })` followed by bundled CLI routing probe | 0 | Standalone hub/helper, CLI, release operations, notices, node-pty fallback, the exact signed zmx qualification manifest, Rubato Ed25519 manifest, and `rubato remote uninstall` confirmation gate were assembled and verified. |
| `/usr/bin/swift scripts/remote-release/qr.swift https://example.ts.net/rubato/ /tmp/rubato-qr.png` | 0 | Valid 248x248 PNG QR generated. |
| Repeated clean `zig build -Doptimize=ReleaseSafe` builds at exact commit `0266042...` | 0 | Builds succeeded and reported zmx 0.7.0, but same-size arm64 outputs had different SHA-256 values (`39588b72...`, `7579c8c1...`) and 302 differing bytes with different Mach-O `LC_UUID`s. Therefore no arbitrary local hash is stored in `third_party/zmx-lock.json`; CI builds once and signs/checksums the exact uploaded bytes. `git describe --tags` was `v0.7.0-47-g0266042`; no tag contains the commit. |
| `RUBATO_ZMX_BIN=/tmp/rubato-zmx-assets/zmx-darwin-arm64 bun test .../real-pty.smoke.test.ts` | 1 | The existing pinned-zmx test timed out after 5 seconds because this unqualified source-built zmx attach remained open. The production smoke utility instead subscribes before input, waits for the exact echoed frame, then explicitly closes only the attach client; that path subsequently passed. |
| `tailscale status --json` | 0 | `BackendState` was `Running` and the local node was online. |
| `npm test` | 0 | Root suite passed, including 3,268 runtime/harness tests (one platform skip), protocol, CLI, hub, and terminal tests (one installed-zmx-path skip). |
| `npm run typecheck`; `bun test patch-tests`; `node harness/scripts/build-engine.mjs --check` | 0 | All workspace typechecks passed; 229 patch tests passed; the built engine was current. (historical: patch-tests retired with the vendor patch overlay) |
| LSP diagnostics for changed source directories | unavailable | The Rubato LSP daemon socket did not become reachable. Root `npm run typecheck` passed instead. |

## Final audit and external qualification gates

- Final full integration command completed with `FINAL_AUDIT_GREEN`: root tests, workspace typechecks, engine build/check, 229 patch tests, Hub npm clean-install dry-run, notice shipping checks, production audit, and `git diff --check` all exited 0.
- Independent fresh-eyes review accepted the final code after reproducing the legacy update guard, native-session qualification identity, nonzero pending qualification gate, fail-closed offline uninstall, secure npm lock, license/notice policy, and production audit.

- GitHub-hosted release signing, OIDC attestation, release upload, and the Intel runner were not executable locally. Local Ed25519 signing/self-verification and both arm64 and Rosetta x86_64 one-time-asset smoke paths passed.
- Uninstall still removes leftover `/rubato` Serve handlers whose target matches this installation; fixture tests prove unrelated routes and listeners remain unchanged. No `serve reset` or broad clear command exists in these scripts. Install no longer creates those routes.
- `rubato remote doctor`, `rubato remote update --release ...`, and confirmed `rubato remote uninstall --yes` now route to the production release operations. Update remains blocked by named live sessions unless `--force-live` is explicit.
