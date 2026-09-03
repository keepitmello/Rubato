---
name: consult
description: "Send a packet to a ChatGPT project via Aside and verify the answer. Default route for consultation, research, and design review."
---

# Consult

Send one self-contained packet to ChatGPT through Aside. The outer agent owns
the question, packet title, packet, ID, saved evidence, and local verification.
The deterministic Aside REPL runner owns the configured project path;
Aside's adaptive browser skill and the Playwright implementation are not
automatic fallback senders.

## Workflow

1. Require exactly one explicit `--quality xhigh` or `--quality pro` flag.
   With no flag, both flags, or any other value, stop before writing a packet or
   opening Aside.
2. State one precise question and what the answer must settle.
3. Write a focused packet whose first line is one concise Markdown H1 containing
   only the subject title (`# <title>`), followed by the decisive evidence,
   constraints, failed attempts, and acceptance criteria. Never add task
   framing such as `Consult`, `review request`, `검토`, `리뷰 요청`, or
   `분석 요청` to that title. Check the packet for secrets and stale context.
   Ask for a natural Korean report while leaving structure and terminology to
   the consultant. The runner attaches this file unchanged; it never pastes the
   local path into the browser.    Python reads the packet and embeds its bytes in the Aside REPL script
   argument, so any locally readable packet path works. The composer carries a short ID-bound preamble whose first line is
   that topic and which tells the consultant to use only the attached context,
   state missing evidence, and write a natural, readable Korean report while
   using technical terms or English when helpful.
   When the requested result is a code archive, pass
   `--artifact-output .consult/<run>/artifact.zip`. The same Aside conversation
   sends the packet and downloads the generated zip; there is no Playwright code
   path.
4. Launch `scripts/run_aside_repl_consult.py` as a persistent background
   process with the exact quality and packet paths. The deterministic Aside REPL
   process owns the same project page from upload through send, response completion,
   and optional artifact download. It must not exit between submission and
   response because ending the REPL also ends the page's generation lifecycle.
   Submission must commit in under 120 seconds or exit `75`; never extend or
   retry that submission budget. Aside may buffer markers until the process
   exits, so classify the final transcript by its submission and response
   markers. Use the recorded `submitElapsedSeconds` as timing evidence.
   Exit `76` means the send was clicked but commit could not be proven; preserve
   evidence and never retry or enter any fallback because that could duplicate
   the turn.
   Exit `77` means the user turn committed but the live page did not yield a
   reply. Recover that same conversation through ChatGPT `backend-api`, not by
   opening the project chat list; never resend the packet.
   After submit, backend-api polling is the primary wait. A later
   `--recover-from .consult/<run>/result.json` reruns only that poller. If the page shows
   `요청이 너무 많습니다`, wait and use the backend path. Do not click through
   the modal and keep loading Work.
5. Read the saved response and JSON evidence. The user-turn ID is the send
   receipt. If the assistant omitted the ID, keep the saved reply and use
   `conversationUrl`; do not treat a missing echo as a failed consult.
   Before launch, reject a URL unless it is HTTPS on `chatgpt.com`, its path
   starts with `/g/g-p-`, and ends in `/project`. The project URL and visible
   name come from `--url`/`CONSULT_CHATGPT_URL` and
   `--project`/`CONSULT_PROJECT_NAME` in `~/.codex/consult.env`. Changing
   projects is a config edit, not a code edit.
6. Stay on the project's **Chat** surface. If the banner shows Work mode,
   click `button[data-tpp-toggle-value="chatgpt"]` and wait until Chat is
   `aria-checked="true"`. Never send from Work mode.
   For `xhigh`, require `GPT-5.6 Sol` and a live `매우 높음` (`N of M`)
   receipt. For `pro`, require `GPT-5.6 Sol` and a live `Pro` (`N of M`)
   receipt. Match the Chat slider label, not a Work-mode `5.6 Sol` button.
   Read the exact answer from the saved response file.
7. Confirm that the response answers the packet, then verify every material
   claim locally before acting on it. Discard an unrelated response.

Never use temporary chat, global Chat, or Work mode. Never submit when the
project, Chat surface, model, tier, or ID is unverified.

`references/runbook.md` contains the exact Aside brief and recovery contract.
`references/context-checklist.md` helps with complex packets.
`references/after-advice.md` governs local use of the answer.

## Fallback

There is no automatic alternate sender. If the runner exits `75` before send,
report the UI failure and stop instead of handing the packet to another agent
or browser implementation. Playwright is not part of Consult, including code
artifact generation and download.

For exit `77`, keep the tab open when possible and record both
`conversationUrl` and `targetId`. The operator may attach with `aside repl` to
inspect or recover that exact conversation. A deliberate resend is also
possible by rerunning the original command with new output paths, but it is
always a new project conversation and must never happen automatically.

## Completion

Report the question, project/model/tier evidence, matching ID, advice accepted
or rejected, local verification, and remaining uncertainty.
