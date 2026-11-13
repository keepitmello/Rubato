# Rubato push relay

Phones get thread alerts and companion calls while the Rubato app is closed. Apple wants the APNs
signing key kept private, so it cannot ship to every user's Mac. This Cloudflare Worker holds it
alone, and each Mac pushes through it only to the phones that paired with it.

```
phone ── APNs + VoIP tokens ──▶ relay            (only the phone and the relay know them)
phone ── mints a grant ───────▶ relay
phone ── hands the grant ─────▶ Mac              POST /rubato/push/register over the paired session
Mac   ── grant + alert/ring ──▶ relay ──▶ APNs ──▶ phone
```

A Mac without a grant from a phone cannot reach it. The phone revokes a grant when it unpairs; the
relay then answers that Mac with 410 and the Mac drops it. The relay keeps the tokens, hashes of the
phone secret and of each grant, and the current APNs provider token. It keeps nothing about what it
pushed. The HTTP surface is documented at the top of `src/relay.mjs`.

## Pieces

- `src/` is the Worker. `relay.mjs` holds the routes and the grant checks, `apns.mjs` signs and shapes APNs requests.
- `migrations/` is the D1 schema.
- `mac/grants.mjs` is the Mac's grant store, `~/.rubato/push/grants.json`. `mac/sender.mjs` is the call
  service's ring push, wired in `companion/call-agent/stack.mjs`. `node mac/cli.mjs phones | test` lists
  the paired phones and sends a test alert.
- Thread alerts are sent by the GUI server: `t3-integration/src/push/service.mjs`, fed by the overlay `RubatoPush.ts`.
- The phone side is `t3-integration/overlay/apps/mobile/src/features/rubato-push/`.

`node --test test/*.test.mjs` runs the relay's real SQL on node:sqlite and checks it against a fake APNs.

## Deploy

It lives on keepitmello's Cloudflare account as `rubato-push-relay`
(<https://rubato-push-relay.keepitmello.workers.dev>), with the D1 database `rubato-push`.

```bash
wrangler d1 migrations apply rubato-push --remote   # after adding a migration
wrangler deploy
```

The APNs key exists only as the Worker's secrets: `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` holding the
.p8 text. No copy stays anywhere else. To replace it, make a new APNs key in the Apple Developer
account (Apple allows two at once), pipe the downloaded file into
`wrangler secret put APNS_PRIVATE_KEY`, set `APNS_KEY_ID`, and delete the file. Revoke the old key
only after pushes work with the new one.

Cost: Workers and D1 free tiers cover it; one alert or ring is a few D1 reads and one write.
