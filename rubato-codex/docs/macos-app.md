# Rubato macOS app

Clone contract: change name/icon, the user profile and Rubato workflow wiring.
Preserve upstream native services, permissions and OS-level namespaces rather
than implement replacements. The user explicitly rejected feature exclusions
and complete native-service isolation. The earlier artificial launch gate and
group-path rewrites have been removed. GUI and full-feature verification remain
separate from structural/signature checks.

`./rubato-codex/install.sh install` defaults to an independent `Rubato.app`.
An interactive terminal offers app (default) or existing Codex integration.
Non-macOS users must explicitly select `--target codex`; the installer never
falls back to modifying an existing profile because app creation failed.

| Resource | Separate app | Existing Codex mode |
| --- | --- | --- |
| Application | `/Applications/Rubato.app` | Original application is unchanged |
| Codex config, prompts, roles, plugins, sessions | `~/.rubato/codex` | `$CODEX_HOME` or `~/.codex` |
| SQLite | `~/.rubato/codex/sqlite` | Native default |
| Electron profile | `~/Library/Application Support/Rubato/Codex` | Native default |
| OpenCodex configuration | `~/.rubato/codex/opencodex` | Existing selected OpenCodex home |

The separate app does not copy auth, history, instructions or private provider
credentials from the original. Log in separately. Shared/repository skills may
still be discovered by native Codex; the existing bundle-collision rules apply
only within the chosen Codex home's config. Rubato-specific plugin skills are
not installed into `~/.agents`. This is profile separation, not a filesystem
sandbox against projects that both applications can access.

`--target codex` preserves unmanaged global AGENTS text and settings, but adds
the Rubato routing block, replaces the configurable base-instructions pointer,
installs native roles/plugin and disables recognized duplicate skills in that
profile. It is not a wholesale profile deletion, but it changes working behavior.
Existing installations are not automatically uninstalled or migrated when the
new separate-app mode is selected.

## Build and identity

Initial creation reads a verified local official app (`--upstream-app` overrides
the default `/Applications/ChatGPT.app`). It builds in a staging directory on the
target volume, installs the bundled workflow in the isolated home, then renames
the completed app into place. A pre-existing unrelated `Rubato.app` is refused.

The native launcher sets the isolated homes and the actual Chromium
`--user-data-dir` argument before executing the preserved upstream executable.
It refuses to launch while the official app is running; it does not kill it.
Concurrent use is unsupported. `--rubato-print-paths` reports paths without
launching the upstream executable.

The main bundle ID is `app.rubato.codex`. Finder metadata and Electron runtime
name are Rubato. The default icon reuses Rubato's existing remote-web icon;
`--icon /path/to/icon.png` or `.icns` can override it. The upstream Dock tile
plugin is retained unchanged; Electron also receives the Rubato Dock icon.
Upstream URL/document handlers are retained, including auth callbacks. Actual
callback delivery to the intended profile must be verified with one app running.

Only locally built applications are produced; OpenAI binaries are not committed
or redistributed in this repository. The new launcher, updater entrypoint and
outer bundle are signed locally. The main executable's signature also needs
refreshing because its original signature binds the old Info.plist; its original
instructions and entitlements are preserved. Frameworks, services and native
modules retain their bytes and signatures. Native permission
stores can therefore be shared with the official app; private Codex/Electron
profiles are not a claim that OS services or credentials are fully isolated.
In particular Owl Safe Storage/login persistence needs a launch/login/relaunch
test. **The installer does not enable mock/plaintext keychain mode.**

## Update

The real executable entrypoint `~/.local/bin/rubato-update` points into the app:

```sh
rubato-update                 # check and install if newer; close Rubato first
rubato-update --check
rubato-update --doctor
rubato-update --version
rubato-update --rollback      # swap with the owned previous app; preserve data
```

The update engine reads the pinned official static appcast, selects a full ZIP
for the current architecture, verifies its length and Sparkle Ed25519 signature,
then verifies the extracted app's Apple code-signing chain, OpenAI team ID,
bundle ID and advertised version/build. Trust values live in one JSON file.
It runs the same transform as first installation. The original ChatGPT app does
not need to update first and is never the update destination.

The observed updater-manager boundary is structurally checked and adapted to
the same CLI engine. Existing update checks open a Rubato check/install dialog.
The original Sparkle engine remains disabled. An independent application-menu
entry and CLI remain if that adapter no longer matches. Set
`RUBATO_FORCE_UPDATE_UI_FALLBACK=1` during build to exercise that fallback.
The receipt records hook mode and patched source hashes. Current implementation
shows checking state in the existing manager; download/install happen after
the app exits and are recorded in the updater log, not a fake in-app progress bar.

The UI asks the user to save work before quitting its own Rubato process; the
detached updater waits for that exact PID, updates and opens Rubato again. CLI
updates refuse a running target rather than terminate it. Rename failure restores
the old app. The latest previous app is retained for explicit rollback. Automatic
GUI-health rollback is not implemented; a signature check is not launch proof.

Upstream app updates preserve external user data and the embedded Rubato
transform version. To update Rubato's own integration code/bundle, update this
repository and rerun `install.sh install --target app`.

## Acceptance boundary

Static/unit checks and code signatures do not establish UI/login compatibility.
Before treating the new app as ready, verify launch, login persistence, native
session/SQLite writes, Finder/Dock/Command-Tab/Launchpad branding, the actual
update button, forced fallback, and older-to-current official update/rollback.
The official app must be closed for GUI checks. Do not disable Gatekeeper or
weaken credential storage to force a green result.

The existing installer can leave managed dependencies after a first-install
failure before its state file is saved; retry is supported, full transaction
rollback is not. App removal is explicit (move the app to Trash); isolated user
data is retained. Never recursively remove `~/.rubato`, which also contains
unrelated Rubato Pi state.
