# Rubato macOS launcher

`install.sh install --target app` creates `/Applications/Rubato.app`, a branded
profile launcher for the unchanged, officially signed `/Applications/ChatGPT.app`.
Use `--upstream-app` to select another verified official installation. The source
must remain at that location. No original executable, entitlement, Info.plist,
ASAR, framework or native helper is modified or re-signed.

Finder/Spotlight entry: Rubato name and icon. The running application, Dock and
About retain ChatGPT identity. This is the accepted branding boundary, not a
separately re-signed native app. Existing Codex settings and credentials are not
copied or modified. Native OS services/keychain namespaces retain official identity.

The default icon is the user-supplied luminous Rubato glyph/starfield image.
`macos/Rubato.png` removes the original outer black padding and fills the square
canvas; `macos/Rubato.icns` is its multi-resolution macOS packaging. The installer
uses the bundled ICNS by default, without depending on the Downloads folder.

## Profiles and updates

- Codex workflow/config/plugins/roles: `~/.rubato/codex`.
- SQLite: `~/.rubato/codex/sqlite`.
- Electron: `~/Library/Application Support/Rubato/Codex`.
- The launcher uses NSWorkspace to start the original app with those environment
  values and `--user-data-dir`; already-running official apps are refused rather
  than killed or silently reused. Close ChatGPT before starting Rubato.
- Update the official app using its official updater. Rubato does not patch
  Sparkle or intercept its UI. `rubato-update` now explains this boundary; it does
  not download or re-sign a clone. Update this repository and rerun the installer
  to refresh Rubato's workflow bundle/launcher.
- The old broken clone may remain as the installer-owned `.previous` backup;
  launcher-mode rollback refuses to promote it as a working application.
- Removal is explicit: move Rubato.app to Trash. User data and original app remain.

## OpenCodex

The development machine uses its existing local proxy and catalog via the separate
profile's `openai_base_url`, `experimental_realtime_ws_base_url` and
`model_catalog_json`. The installer preserves the previously selected provider
configuration location. Authentication files are not copied. The shared proxy
is not restarted. Cursor/xAI credentials and direct Grok response were checked;
Anthropic direct login and in-app model execution remain separate acceptance items.
A selected provider is not evidence of authentication. There is no automatic
existing-service attachment for a new machine.

## Actual verification

A completely unchanged copy of the official app launched with a temporary profile,
created a visible window and wrote its SQLite/Electron state in that profile.
The installed launcher started the original app with the Rubato profile. These
runtime checks, rather than `codesign --verify` alone, are necessary: the previous
re-signed implementation passed static checks but was killed by AMFI for restricted
entitlements, then failed library validation in a diagnostic copy.

On first use, verify login/relaunch, a small edit/test, and a small approved
Sol/medium owner plus Grok worker taskforce. Confirm actual models, continuation
with the same owner and board completion evidence. Browser, Computer Use, OAuth
callbacks, notifications and official updates need their own actual interaction
checks; process startup alone does not establish all-feature parity. Do not lower
Gatekeeper/SIP/library validation or enable mock/plaintext keychain to pass tests.
