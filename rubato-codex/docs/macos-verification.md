# macOS implementation checkpoint — 2026-09-08

## Latest: original-signature profile launcher

This section supersedes all clone-transform acceptance below. Actual launch
revealed AMFI rejection of the re-signed main's restricted entitlements; removing
those in a diagnostic copy then exposed library-validation Team ID mismatch.
No OS security setting was weakened. The installer now builds a branded launcher
that starts the untouched official app through NSWorkspace with Rubato profiles.
Finder entry is Rubato; running Dock/About identity remains ChatGPT, as accepted.
The original official updater is retained. See macos-app.md for current behavior.
Original app Info.plist/ASAR and original Codex config hashes matched baseline.
The native structural test now verifies the original OpenAI signature and launcher
routing rather than treating preserved restricted entitlements as launch proof.

Installed `/Applications/Rubato.app/Contents/MacOS/Rubato` launched the official
app (PID 23415) with the Rubato user-data argument. After normal app quit, opening
Rubato.app again launched PID 50631. The accessibility window query reported a
visible/frontmost 1090x760 ChatGPT window; native logs recorded primary frame load
and ready-to-show at 633/1033 ms on relaunch. Rubato's SQLite directory contained
fresh state/log/queue/memory databases. Screenshot capture was unavailable; no
pixel-based UI claim is made. Login/model calls/CUA interaction remain unverified.
Full pipeline passed 59 package and 11 board tests, with two opt-in native CLI
tests skipped; the launcher-native signature/routing test was enabled. Updated
focused macOS regressions passed 6/6. This work has not been committed or pushed.

## Current contract (supersedes the earlier isolation stop below)

The user explicitly requires a clone with changed name/icon and Rubato profile,
skills and workflow, not an independent OS-service implementation. Native CUA,
notification, keychain namespaces and upstream URL/document/Dock handlers are
retained. The artificial launchAllowed gate, JS group rewrites, appData rewrite
and invented entitlement list were removed. Native service sharing is not a
feature exclusion criterion under this clarified contract.

The original main executable's signature binds the old Info.plist, so leaving
that signature unchanged failed code-signing validation. Refresh it while
preserving original executable instructions and entitlements; leave framework,
service and native module signatures untouched. A new opt-in read-only native
test compares the built payload against the source instead of assuming this.
GUI/login/native-feature behavior still requires actual runtime verification.

The corrected clone was successfully rebuilt and installed at
`/Applications/Rubato.app`. The read-only native comparison passed: 6,528
upstream filesystem files and 8,526 packed ASAR entries were unchanged; main
executable instructions and original entitlements matched. Original handler
metadata and deep/strict signature validation passed. The full pipeline with
both native E2E flags enabled passed 61 package and 11 taskforce tests with no
skips, plus skill, role and distribution freshness checks. Original app
Info.plist/app.asar and original Codex config/AGENTS hashes still matched the
pre-change baseline. These are payload/installer checks, not GUI runtime proof.

The previous bundle/prompt work was committed and pushed first as
`0d2f2bdf67360e8e9403f005b62fc6289dbea7ae` on `rubato/base`; remote HEAD was read back.
The new macOS work in this checkpoint is not yet committed; GUI verification
remains pending.

## Implemented and measured

- Installer CLI offers `app` / `codex`; separate app is the default. Existing
  Codex config mutation requires explicit selection. Programmatic plugin tests
  retain their explicit-home API.
- `/Applications/Rubato.app` created from verified official app 26.901.51231/8109.
  Name Rubato, ID `app.rubato.codex`, existing Rubato R icon. No older Rubato.app
  existed to rename. Existing Rubato Pi/remote state was not moved.
- Native launcher `--rubato-print-paths` ran and reported isolated Codex, SQLite
  and Electron paths. This diagnostic does not launch Electron.
- App code signature verification passed. This does NOT mean every auxiliary
  OpenAI service acquired a new identity: review proved the opposite for CUA.
- Actual full official ZIP 26.901.41600/7982 downloaded, archive signature and
  extracted OpenAI signature verified, transformed and installed.
- Real `rubato-update --check` reported 26.901.51231 available; bare
  `rubato-update` downloaded/verified/rebuilt/installed 7982 → 8109 successfully.
- `rubato-update --rollback` restored 7982; second rollback restored 8109.
- Hashes of original ChatGPT Info.plist/app.asar, original Codex config/AGENTS,
  isolated config/AGENTS/owner role were identical before and after that update.
- `rubato-update --doctor` passed managed-app/signature/updater/appcast checks.
- Full native-enabled package pipeline passed 58 package + 11 taskforce tests.
  Subsequent focused macOS checks passed 5/5, including mutation lock cleanup.
- Initial updater symlink `$0` resolution regression was fixed and the real
  `~/.local/bin/rubato-update` command was used for the successful update.

## Previous isolation experiment (superseded)

Independent read-only review found official CUA application-group identity in
both native services and the JS approval-store code. `codesign --deep` did not
re-sign every auxiliary service. The copied Codex Computer Use and
SkyComputerUseClient apps, plus native sky.node, retained official entitlements.
Native service strings also contain the original approval-store namespace.

JS group-path remapping and removing the original `.skill` document claim are
implemented, but JS remapping alone cannot make native services independent.
The launcher now requires `launchAllowed`, which the builder writes as false.
The build receipt is `blocked-native-isolation`, and installation reports
`readyForUse: false`. No GUI use is authorized by these structural checks.
The installed final checkpoint was rebuilt with this guard; its real native
launcher reports `launchAllowed: false`. The rebuilt signature passed and
LaunchServices registration completed as Rubato. This is not a rendered UI test.

The user subsequently rejected that isolation/feature-exclusion choice and
clarified the clone contract above. Owl Safe Storage/login persistence remains
unverified; mock or plaintext credential storage has NOT been enabled.

## Still unverified / remaining

- GUI launch/login/relaunch, actual session/SQLite writes and native tool flows.
- Finder/Dock/Command-Tab/Launchpad/About/notification rendered branding.
- Existing update button runtime delivery, forced UI-fallback runtime test.
- Automatic GUI-health rollback (only explicit rollback/rename recovery exist).
- Appcast minimum-system-version compatibility filtering (metadata parsed;
  currently tested host 26.6.2 satisfies tested releases' minimum 13.0).
- Physical clean-machine and non-arm64/macOS support.

Do not claim full feature compatibility merely because code-signing checks or
unit tests pass. Do not stop the original app to test without the user's next
direction. Preserve unrelated dirty Rubato Pi files.
