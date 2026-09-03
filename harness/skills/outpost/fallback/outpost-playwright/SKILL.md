---
name: outpost-playwright
description: "Aside 주경로가 실패했을 때만 쓰는 ChatGPT Work Playwright/agbrowse 폴백. 평소에는 읽지 않는다."

---

# Outpost Playwright Fallback

Load this skill only after the main Outpost Aside path fails, or when the user
explicitly requests the Playwright fallback. This skill is not installed in an
ordinary Agent Skills root and must not compete with `outpost`.

Send one self-contained packet to the ChatGPT web UI through `agbrowse web-ai`, bring GPT-5.6 Pro's answer back as evidence, and act on it only after local verification.

Outpost carries two kinds of load, not just questions. An **advice outpost** buys the strongest single read available — research, design, diagnosis, review. A **work outpost** hands Pro a complete piece of work it builds and exercises in its own sandbox — implementation, a patch, tests, a runnable experiment — through code mode (see Code artifacts). When the task is buildable, prefer handing the whole build over asking how to build it: the sandbox result is stronger evidence than an opinion. The boundary is sandbox fit, not difficulty — a work outpost needs all inputs to travel in the packet and verification to run inside Pro's sandbox; code that depends on local services, databases, or repo state the sandbox cannot reach gets an advice outpost on strategy or review instead, so a passing artifact never fakes confidence its dependencies were never tested against.

## Workflow

1. State one precise outpost question and what a decisive answer would settle. For a work outpost, state the deliverable and its acceptance criteria instead, and submit through `scripts/run_agbrowse_code.py` at step 3 — the packet discipline below applies unchanged.
2. Write one focused, self-contained packet directly from the evidence already gathered — the sending agent owns the question, the evidence selection, and the final text. Include everything that can change the answer: the exact question, code or diff excerpts with paths, decisive logs, constraints, failed attempts, acceptance criteria. There is no size cap — completeness beats brevity. Use read-only subagents only when two or more independent evidence branches (code/diff history, runtime/tests, current external docs) each need real digging; they return minimal decisive excerpts and the main agent decides what enters the packet. Before sending, read the finished packet once for secrets, unnecessary personal data, and stale or missing context.
3. Submit with `scripts/run_agbrowse_outpost.py` as a persistent background process and keep working — Pro can run for an hour. **The helper process's terminal completion is the normal completion signal.** Start it with the harness's background-session option so an outer foreground timeout cannot kill it; do not wrap it in a shell command whose deadline is shorter than the helper's `--timeout`. Do not monitor `outpost_history.py recent`, a session file, or a repeated `OUTPOST_WAITING` string for completion: those are snapshots, not provider terminal events. The helper already sends, polls, validates, writes the response, and exits when the provider reaches a terminal state. A packet is a file transport: `--packet` and `--follow-up-file` must be uploaded as attachments, and their bodies must never be pasted into the ChatGPT composer. Use inline transport only for a genuinely short `--follow-up "..."`. Responses and evidence land under `.outpost/`; read the answer from the saved response file, not from a terminal or tool-output capture, which can clamp long responses. Independent questions run concurrently, one background helper process each with run-specific artifact paths; `references/runbook.md` has the exact commands, flags, history lookup, recovery, and the parallel recipe.
4. Trust only a response the helper validated. On a routing mismatch it exits nonzero and quarantines the raw answer under `MISROUTED-` names — never treat quarantined output as the answer.
5. Before a follow-up or recovery, run `scripts/outpost_history.py recent`, choose the exact topic/run, and use its saved session rather than guessing from whichever `.outpost/` directory is nearby. Follow up in that session for narrow questions or rebuttals; build a new packet when material facts changed. Calls to the same saved session serialize; unrelated sessions stay parallel.
6. Read the response critically: verify each material claim against repository evidence, tests, or current primary sources, and watch for internal inconsistencies and unstated assumptions. When a claim is weak, inconsistent, or strategy-changing, send a rebuttal and continue until positions converge or the disagreement is clearly mapped. Wholesale acceptance is a outpost failure equal to ignoring the advice.
7. Apply only changes the main session independently accepts and verifies.

`references/context-checklist.md` when a complex packet risks missing material context. `references/after-advice.md` before applying advice or inspecting a returned code archive.

## Quality tiers

There is no default tier. The caller must explicitly pass `--quality pro` or
`--quality xhigh`; without one, stop before browser launch. `pro` (GPT-5.6 Pro)
is for questions that deserve the strongest single read. `xhigh` (GPT-5.6
Thinking / Extra High) is for ordinary bounded outposts.

Cost is not the axis that decides this — usage is effectively free, and a background submit hides latency. What actually gets spent on `pro` is the asker's wait: Pro thinks for many minutes and can run to an hour, so pointing it at an everyday question buys nothing and delays the answer. Reach for `pro` when the question is genuinely heavy, and let ordinary ones ride `xhigh`.

Selection fails closed: if the visible model picker cannot verify the requested GPT-5.6 family and tier, the outpost stops before sending — an unverified current model is not an acceptable fallback.

## Response language

The reader of every outpost result is a Korean speaker. Ask for a Korean report while leaving structure, depth, terminology, and rhetoric open to the consultant's judgment:

> 답변은 한국어 보고서로 작성해 주세요. 문제에 맞는 구조와 표현을 자유롭게 선택하되, 자연스럽고 읽기 쉽게 설명해 주세요. 기술 용어와 영문 표현은 도움이 될 때 자유롭게 사용해도 됩니다.

The packet body itself can be in whichever language expresses the problem most precisely — mixing is fine — but the requested output language is always Korean. Do not impose a fixed conclusion/rationale/action template or ban useful jargon by default. If a response comes back in English anyway, send a short follow-up asking for the same content in Korean rather than translating it locally, so the evidence saved under `.outpost/` stays in the language the reader will use.

## Boundaries

- One browser owner: use only `scripts/ensure_outpost_chrome.py`, which serializes startup on port 9222 and stops Chrome after the invocation closes its exact provider tab. **Never** use private ChatGPT endpoints, token or cookie extraction, stealth, hosted browsers, reverse proxies, or access-control bypasses. `references/web-automation-boundaries.md` has the full allowed/not-allowed list and runtime constants.
- **Never** put secrets, credentials, private keys, customer data, or unnecessary personal data in a packet.
- Login, CAPTCHA, MFA, and other human security steps belong to the user in the visible browser.
- `agbrowse` is a global package — confirm the installed version and release evidence, then get authorization before updating it.
- One profile, one browser instance. Concurrency comes from agbrowse `--parallel` tabs and parallel-safe saved sessions, never from cloned profiles or extra headed browsers.

## Code artifacts

`scripts/run_agbrowse_code.py` when the deliverable is code Pro builds and exercises in its own sandbox — a draft, a patch, or a zip package. Hand it real implementation whenever the build is hard enough that Pro's brain pays for the round trip. Artifacts save under `.outpost/code-artifacts/`; read the plan first, inspect the diff in isolation, apply only reviewed parts, and run local tests. A generated archive is input to review, not a patch to apply.

## Completion

Report the outpost question, source/session evidence, advice accepted or rejected with reasons, local verification results, and remaining uncertainty. Mark project selection or other unverified environment assumptions explicitly.
