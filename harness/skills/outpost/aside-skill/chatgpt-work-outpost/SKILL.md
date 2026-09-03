---
name: "chatgpt-work-outpost"
description: "Recover a failed deterministic Outpost send by adaptively operating an explicitly xhigh or pro ChatGPT project conversation. Do not use for the normal fast path."
---

# ChatGPT project Chat outpost

Execute a packet outpost on chatgpt.com inside the project named in the task. Do not
rediscover the UI. Do not run this skill unless the task supplies an exact
packet, exact ID, and exactly one `QUALITY: xhigh` or `QUALITY: pro`.
This is the adaptive recovery skill after `run_aside_repl_outpost.py` detects UI
drift; ordinary outposts must not invoke an Aside agent.

## Inputs

Accept the packet and ID exactly as given in the task prompt. Do not rewrite, trim, wrap, or translate the packet.
`PACKET_BEGIN` and `PACKET_END` are transport delimiters; send only the text
between them.
If `QUALITY` is absent or is not exactly `xhigh` or `pro`, return an error before
opening or attaching to a browser tab.

## Browser and REPL

- Prefer an already logged-in chatgpt.com tab. If none exists, open `https://chatgpt.com`.
- Snapshot first. After every action, take a fresh snapshot and use only new refs.
- Do not declare reusable top-level `const` or `let` bindings. Store intermediate
  values on `globalThis` with an ID-derived key, or use a fresh `var` name;
  the REPL scope persists across calls.

## Surface: project Chat, never Work mode

1. Enter the ChatGPT project named in the task (`PROJECT` / visible name).
2. Create a **new Chat-surface conversation** inside that project unless the
   task supplies `THREAD` / `CONVERSATION_URL`. In that case open that exact
   `/c/` conversation and send a follow-up there.
3. Never use temporary chat.
4. Never submit from global Chat.
5. Never send from Work mode. The banner toggle is
   `button[data-tpp-toggle-value="chatgpt"|"work"]` inside
   `radiogroup "채팅 화면 선택"`. Click Chat and wait until
   `aria-checked="true"` / `data-state="on"`.
6. Do not open or inspect unrelated existing conversations.
7. Before send, verify a visible project marker/breadcrumb **and** a
   project-owned Chat composer.
8. If that project cannot be verified, stop before send.

Known project-home path:

1. Navigate directly to the supplied project URL. Ignore temporary/global
   Chat tabs rather than repairing them.
2. Require page title `ChatGPT - <PROJECT>`, heading `<PROJECT>`, and textbox
   `<PROJECT>에서 새 채팅`. These three signals prove the project-owned composer.
3. Switch the banner to Chat before touching the picker. Work mode replaces
   the Chat picker with `5.6 Sol 매우 높음` and Fast; do not operate that UI.
4. The project-home Chat composer starts a new project conversation. Do not
   open an existing chat from the project list unless the task is an explicit
   follow-up with `THREAD` / `CONVERSATION_URL`.

## Model and tier

Both qualities require:

- Surface: **Chat**
- Model: **GPT-5.6 Sol** checked

Quality mapping on the Chat slider (`즉시` `중간` `높음` `매우 높음` `Pro`):

- `xhigh`: **매우 높음**
- `pro`: **Pro**

If the family or requested tier cannot be verified, stop before send.

Known picker path:

1. Open the current Chat tier button once (`즉시`/`중간`/`높음`/`매우 높음`/`Pro`
   or `추론 수준`).
2. In the simple tier view, read the current `N개 중 M번째` index.
3. Focus the `성능` menuitem and move with `ArrowLeft`/`ArrowRight` until
   the label is `매우 높음` for `xhigh` or `Pro` for `pro`.
4. Require that label at `N개 중 M번째`. Do not keep probing after that label.
5. Only after the tier is verified, open `모델 선택` and require the checked
   radio `GPT-5.6 Sol`. Click it if visible and unchecked.
6. Press `Escape` to close the picker. Do not try to navigate back from the
   model submenu to the simple tier view.

## Composer and send

1. Fill the composer first. Clearing after attach can drop the packet file.
2. Try a normal locator fill once.
3. If contenteditable fill fails, take a fresh snapshot, focus the project
   textbox, press `Meta+A`, press `Backspace`, then use keyboard `insertText`
   with the exact packet.
4. Read the ProseMirror contenteditable back by joining each direct child
   block's `textContent` with `\n`, then require exact equality. Do not compare
   `innerText`: it inserts an extra display newline between adjacent `<p>`
   blocks. Do not trim or collapse whitespace. If the block-joined value
   differs, repeat that clear-and-insert sequence once after a fresh snapshot;
   then stop with an error rather than trying another input method.
5. Attach the packet after the composer text is verified. Send only if the
   filename chip is still visible and Chat/model/tier checks pass.

## Wait and extract

- Wait until generation is terminal. Do not harvest a partial reply.
- Recover the exact assistant text from an accessibility snapshot.
- Use Copy only as an optional fallback if snapshot text is incomplete.
- The user-turn ID is the send receipt. Save the assistant text even if it
  omits the ID. Do not drop a completed reply because the echo is missing.

## Output envelopes

For `xhigh`, success has this exact metadata:

```text
ASIDE_WORK_OUTPOST_RESULT
ID: <exact ID>
SURFACE: Chat
QUALITY: xhigh
MODEL: GPT-5.6 Sol
TIER: 매우 높음 (N of M)
RESPONSE_BEGIN
<exact ChatGPT response including its ID>
RESPONSE_END
```

For `pro`, success has this exact metadata:

```text
ASIDE_WORK_OUTPOST_RESULT
ID: <exact ID>
SURFACE: Chat
QUALITY: pro
MODEL: GPT-5.6 Sol
TIER: Pro (N of M)
RESPONSE_BEGIN
<exact ChatGPT response including its ID>
RESPONSE_END
```

Failure, exact format:

```text
ASIDE_WORK_OUTPOST_ERROR
ID: <exact ID>
SURFACE: <last verified surface, or unknown>
QUALITY: <xhigh-or-pro-or-missing>
BLOCKER: <concrete blocker>
```

Never fabricate response text. If Chat surface, model, tier, composer, generation, or ID matching fails, emit the error envelope and stop.
