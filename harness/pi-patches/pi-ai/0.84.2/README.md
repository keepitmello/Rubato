# pi-ai 0.84.2 provider patches + owned overlay

Lead-owned: `manifest.json`, applicator, stager, root deps. **Do not apply this
directory by editing those here.** Integrate as below.

Stock: `@earendil-works/pi-ai@0.84.2` MIT. Fork behavior source:
`@code-yeongyu/senpi-ai@2026.9.4-3` MIT. Cursor tree is **fork-only** (stock
0.84.2 has no `dist/api/cursor-agent.js`).

## Patch order (`--batch --forward --fuzz=0`)

Independent files; apply in this order so postimage hashes match:

1. `event-stream-local-work.patch` — `trackLocalWork` / `hasPendingLocalWork` / `fail`
2. `anthropic-compaction.patch` — `compaction` / `compaction_delta` receive + replay
3. `openai-codex-configuration-update.patch` — configuration_update + no temperature on gpt-6-astra
4. `overflow.patch` — Codex overflow wording + silent overflow ignores cacheRead
5. `google-input-guard.patch` — `model.input?.includes`
6. `thinking-levels.patch` — Shift+Tab graded levels (no off/minimal)
7. `oauth-cursor-loader.patch` — `loadCursorOAuth`
8. `index-empty-recovery-exports.patch` — re-export visible-text + empty-recovery-gate
9. `prompt-cache-ttl-export.patch` — after (8); re-export owned `prompt-cache-ttl.js` (GPT-5.6 1800s baked)

Then **copy** `owned/` onto the same tree (overlay, do not rename the package).
Owned new files (`sha256: null`): `dist/utils/prompt-cache-ttl.js` postimage `e8b530a08a7841e5bd9e4801387ee36099f911a7965c394a13c9806bace3364f`.

## Manifest files to add (lead)

| path | role | pristine sha256 |
|---|---|---|
| package.json | identity | (stock 0.84.2) |
| dist/utils/event-stream.js | patch | `44a2498660ca61efa952ad6a3f10cc0491883411bd2b4572c9a392ec4e9553ec` |
| dist/api/anthropic-messages.js | patch | `a084ca44b7151e5bc33fddc5b6da458220920c797b2485c7651c685c8dd31faa` |
| dist/api/openai-codex-responses.js | patch | `cf537f03ee3da7a7edbe28e447642a50d34e6a32a4f8aef599b5a496394e3999` |
| dist/utils/overflow.js | patch | `5537cdf670ea8592a46a48a61c847f47a72dd9cab8505165b8e3abc9cba978d3` |
| dist/api/google-shared.js | patch | (google-input-guard) |
| dist/api/transform-messages.js | patch | (google-input-guard) |
| dist/models.js | patch | `3640032062f2aced8e15f111eebc6e92ce373241987c4a1443df248be225f56d` |
| dist/auth/oauth/load.js | patch | `6dcc6e0be9e97722443ff8ac464e11f45b86af2928ee7b21179eb42f6cbf5873` |
| dist/index.js | patch | `2317a3ec8d3b0474e45d6c5cca04c71d3795c21bf83c08008c5a0869f9f33d95` |

Postimage (after that file's patch only):

| path | postimage sha256 |
|---|---|
| dist/utils/event-stream.js | `8ea5a88f150232dc5fcadf0b1dc1e1c8945f121182f5a9f1b1948476782eb898` |
| dist/api/anthropic-messages.js | `57b701f1e966cf7a0497204919c64933d79ccf1082a92e86d7888217519a3720` |
| dist/api/openai-codex-responses.js | `4de0a0540a9ec9228c63cde1efb5744d9d83c791e6281ef5e3b6370f273be933` |
| dist/utils/overflow.js | `1ce667ae9a6ae8bce48095eed49356fec7dd5fbcacd66d998172b5e8a66dbdb7` |
| dist/models.js | `77ae7e56f494036646d4afadf12039793bc719bf11b819d02caa478b57a7a296` |
| dist/auth/oauth/load.js | `6fa572955539526bd763d808df43e90fe9b7b870a7441ba4f77724e626ba976e` |
| dist/index.js | `00909ba803008f27f8862d1f52de598529248c6247fe3f5d0e062b4b872a6aa9` |

## Dependency additions (lead / root — not edited here)

Staged pi-ai must gain:

```
"@bufbuild/protobuf": "2.14.0"
```

Cursor Connect codec (`dist/api/cursor-agent/gen/agent_pb.js`) imports
`@bufbuild/protobuf` and `@bufbuild/protobuf/wkt`. Stock 0.84.2 does not declare it.

No other new runtime deps for the patched stock providers (Anthropic/Codex/xAI/OpenCode
keep stock `@anthropic-ai/sdk` / `openai` / etc.).

## Env / bridge

`harness/rubato-pi/src/pi-provider-bridge.mjs`:

- `PI_STOCK_PI_AI_DIR` → unpacked stock 0.84.2 pi-ai
- missing cursor files resolve from `owned/`
- rejects senpi aliases

## Session-owner hook (not patched here)

`withEmptyAssistantRecovery` is re-exported from patched pi-agent-core `stream-fn.js`.
Wire in agent-loop:

```
streamAssistantResponse(..., withEmptyAssistantRecovery(model, streamFunction), ...)
```

Stock agent-loop has no idle `hasPendingLocalWork` watchdog; that remains coding-agent.

## Uncovered in this group

- GPT-5.6 prompt-cache-ttl (fork-only file; stock anthropic/codex do not import it)
- tool-call-middleware tree (XML/Kimi protocols) — not used by current DIRECT providers
- fork rewrite of `lazy.js` class local-work delegate (stock lazy is a function wrapper; local-work lives on EventStream instead)
- `auth/pool/slots.js` and other fork-only files only imported by fork `models.js`
- Kiro / Antigravity stay Rubato adapters (no pi-ai patch)
- aside-cursor dirty files not touched
