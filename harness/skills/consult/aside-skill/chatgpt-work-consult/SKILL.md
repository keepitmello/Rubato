---
name: "chatgpt-work-consult"
description: "Recover a failed deterministic Consult send by adaptively operating an explicitly xhigh or pro ChatGPT Work-project conversation. Do not use for the normal fast path."
---

# ChatGPT Work Consult

Execute a packet consult on chatgpt.com inside the Work project. Do not
rediscover the UI. Do not run this skill unless the task supplies an exact
packet, exact ID, and exactly one `QUALITY: xhigh` or `QUALITY: pro`.
This is the adaptive recovery skill after `run_aside_repl_consult.py` detects UI
drift; ordinary consults must not invoke an Aside agent.

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

## Surface: Work project, new normal chat

1. Enter the ChatGPT project named **Work**.
2. Create a **new normal conversation** inside that project.
3. Never use temporary chat.
4. Never submit from global Chat.
5. Do not open or inspect unrelated existing conversations.
6. Before send, verify a visible Work project marker/breadcrumb **and** a project-owned composer.
7. If Work cannot be verified, stop before send.

Known project-home path:

1. Navigate directly to the supplied Work project URL. Ignore temporary/global
   Chat tabs rather than repairing them.
2. Require page title `ChatGPT - Work`, heading `Work`, and textbox
   `Work에서 새 채팅`. These three signals prove the project-owned composer.
3. The project-home composer itself starts a new Work conversation. Do not open
   an existing chat from the project list.

## Model and tier

Both qualities require:

- Model: **GPT-5.6 Sol** checked

Quality mapping:

- `xhigh`: **매우 높음**, shown as **4 of 5**
- `pro`: **Pro**, shown as **5 of 5**

If the family or requested tier cannot be verified, stop before send.

Known picker path:

1. Open the current tier button once.
2. In the simple tier view, read the current `N개 중 M번째` index.
3. Focus the `성능` menuitem and use only the required number of
   `ArrowLeft`/`ArrowRight` presses to reach index 4 for `xhigh` or index 5 for
   `pro`.
4. Require `매우 높음, 5개 중 4번째` for `xhigh`, or
   `Pro, 5개 중 5번째` for `pro`. Do not probe beyond the requested stop.
5. Only after the tier is verified, open `모델 선택` and require the checked
   radio `GPT-5.6 Sol`.
6. Press `Escape` to close the picker. Do not try to navigate back from the
   model submenu to the simple tier view.

## Composer and send

1. Try a normal locator fill once.
2. If contenteditable fill fails, take a fresh snapshot, focus the project
   textbox, press `Meta+A`, press `Backspace`, then use keyboard `insertText`
   with the exact packet.
3. Read the ProseMirror contenteditable back by joining each direct child
   block's `textContent` with `\n`, then require exact equality. Do not compare
   `innerText`: it inserts an extra display newline between adjacent `<p>`
   blocks. Do not trim or collapse whitespace. If the block-joined value
   differs, repeat that clear-and-insert sequence once after a fresh snapshot;
   then stop with an error rather than trying another input method.
4. Send only after the exact comparison and Work/model/tier checks pass.

## Wait and extract

- Wait until generation is terminal. Do not harvest a partial reply.
- Recover the exact assistant text from an accessibility snapshot.
- Use Copy only as an optional fallback if snapshot text is incomplete.
- Require the assistant reply to contain the exact ID before reporting success.

## Output envelopes

For `xhigh`, success has this exact metadata:

```text
ASIDE_WORK_CONSULT_RESULT
ID: <exact ID>
SURFACE: Work
QUALITY: xhigh
MODEL: GPT-5.6 Sol
TIER: 매우 높음 (4 of 5)
RESPONSE_BEGIN
<exact ChatGPT response including its ID>
RESPONSE_END
```

For `pro`, success has this exact metadata:

```text
ASIDE_WORK_CONSULT_RESULT
ID: <exact ID>
SURFACE: Work
QUALITY: pro
MODEL: GPT-5.6 Sol
TIER: Pro (5 of 5)
RESPONSE_BEGIN
<exact ChatGPT response including its ID>
RESPONSE_END
```

Failure, exact format:

```text
ASIDE_WORK_CONSULT_ERROR
ID: <exact ID>
SURFACE: <last verified surface, or unknown>
QUALITY: <xhigh-or-pro-or-missing>
BLOCKER: <concrete blocker>
```

Never fabricate response text. If Work, model, tier, composer, generation, or ID matching fails, emit the error envelope and stop.
