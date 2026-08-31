---
name: consult
description: "Aside를 통해 ChatGPT 프로젝트에 패킷을 보내고 답을 검증한다. 일반 상담·리서치·설계 검토의 기본 경로."
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
   local path into the browser. Python reads the packet and sends its bytes over
   REPL stdin as an in-memory attachment, so any locally readable packet path
   works. The composer carries a short ID-bound preamble whose first line is
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
   Exit `77` means the user turn committed but response recovery failed. Recover
   only from the saved `conversationUrl`; never resend the packet.
5. Read the saved response and JSON evidence. Require the ID and quality
   to match the invocation.
   Before launch, reject a URL unless it is HTTPS on `chatgpt.com`, its path
   starts with `/g/g-p-`, and ends in `/project`. The project URL and visible
   name come from `--url`/`CONSULT_CHATGPT_URL` and
   `--project`/`CONSULT_PROJECT_NAME` in `~/.codex/consult.env`. Changing
   projects is a config edit, not a code edit.
6. For `xhigh` and `pro`, require `GPT-5.6 Sol` and a live `매우 높음`
   (`N of M`) receipt. The picker no longer has a separate Pro stop, and
   the slider length moves; match the label, not a fixed index. Read the
   exact answer from the saved response file.
7. Confirm that the response answers the packet, then verify every material
   claim locally before acting on it. Discard an unrelated response.

Never use temporary chat or global Chat. Never submit when the project,
model, tier, or ID is unverified.

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
