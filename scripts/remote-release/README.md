# Rubato Remote release operations

These tools require macOS, Node 24 or newer, and exactly Bun 1.4.0. They never enable Tailscale Funnel and never reset or clear the whole Serve configuration.

For a short Korean walkthrough that starts with installation and ends with an iPhone
checklist, see [USER-TEST.md](USER-TEST.md).

## Build and verify

`third_party/zmx-lock.json` pins zmx source commit `0266042ca8f399c9d76825739b93443e2d5bf47a`, upstream version 0.7.0, Zig 0.16.0, targets, and MIT evidence. It deliberately contains no build hash: this Mach-O build is not byte-reproducible. `build-zmx-release.mjs` builds each architecture exactly once and signs a manifest containing the SHA-256 of the exact bytes that are uploaded. `build-release.mjs` verifies that signed zmx manifest and then covers the same bytes with the signed Rubato release manifest.

```sh
RUBATO_RELEASE_SIGNING_KEY="$(cat release-private.pem)" \
RUBATO_RELEASE_PUBLIC_KEY="$(cat release-public.pem)" \
node scripts/remote-release/build-zmx-release.mjs \
  --output /tmp/zmx-qualified --platform darwin-arm64 --require-signature

node scripts/remote-release/smoke-zmx-release.mjs /tmp/zmx-qualified

node scripts/remote-release/build-release.mjs \
  --output /tmp/rubato-remote-build \
  --zmx-asset /tmp/zmx-qualified/zmx-darwin-arm64 \
  --zmx-manifest-directory /tmp/zmx-qualified \
  --build-id remote-v1-arm64

RUBATO_RELEASE_PUBLIC_KEY="$(cat release-public.pem)" \
  scripts/remote-release/verify.sh --release /tmp/rubato-remote-build
```

Official builds additionally require `RUBATO_RELEASE_SIGNING_KEY` and are signed with Ed25519. The release workflow also emits a GitHub OIDC artifact attestation and tarball SHA-256.

## Install and update

```sh
scripts/remote-release/install.sh \
  --release /tmp/rubato-remote-build \
  --public-key release-public.pem

scripts/remote-release/update.sh \
  --release /tmp/rubato-remote-build \
  --public-key release-public.pem

rubato remote doctor
rubato remote update --release /tmp/rubato-remote-build --public-key release-public.pem
```

A developer-built release can be installed only with the explicit `--trusted-local-build` switch. Updates stop when a live session exists unless `--force-live` is supplied. zmx itself is never replaced while a managed zmx session exists.

The installer atomically stages immutable releases under `~/.local/lib/rubato/remote/releases/`, atomically switches `remote/current`, configures a user LaunchAgent, writes owner-only state, records the logged-in Tailscale owner, encrypts the launch environment through the live CLI, configures only `/rubato` and `/rubato/api` Serve handlers, runs zmx and terminal bridge smoke checks, and writes an owner-only PNG QR code.

If Tailscale is not logged in, assets are staged but no release is activated. No auth key is generated; log in with `tailscale up` and rerun install.

## Uninstall

```sh
rubato remote uninstall --yes
# Also revoke this host's Push profile:
rubato remote uninstall --yes --remove-push
```

Uninstall stops by default when live sessions exist. It removes only Serve handlers whose target exactly matches this installation, preserving every unrelated handler and listener. Transcripts, journals, snapshots, artifacts, audit logs, encrypted launch environment, and push state are preserved. `--remove-registry` additionally removes host, owner, origin, and favorite records. `--remove-push` removes only the host's active Push profile while preserving VAPID/key material and reports that browser cleanup is still required. Removing a host in the PWA calls the authenticated host revoke endpoint first and calls browser `PushSubscription.unsubscribe()` when the last host is removed.

## Qualification

The repository-owned argv-only driver covers the host-side Stage 30.8 workload with measured acknowledgements, ordered journal persistence, bounded-memory 500 MiB streaming, stable session PID checks, native zmx reconnect and terminal attach smoke, hub restart/CLI recovery, RSS sampling, and cleanup. Long runs require the installed-prefix environment variables named by the driver; an optional external mobile driver can only augment the two device actions.

```sh
node scripts/remote-release/qualification.mjs \
  --profile long --pid "$RUBATO_HUB_PID" \
  --mobile-driver-json '["/optional/physical-iphone-driver"]' \
  --output qualification-long.json
```

Without a physical-device augmentation driver, foreground/background and network-transition actions remain exactly `IMPLEMENTED, RENDER VERIFICATION PENDING`, and the report has `passed: false`. CI runs the same built-in driver with the short profile rather than incrementing mock counters.
