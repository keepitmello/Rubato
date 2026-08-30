# Frontend Creation

Use this workflow for new pages, flows, dashboards, landing pages, first drafts, redesigns, and frontend implementation that combines UX, content, interaction, and visual direction.

The durable rule behind everything below:

> Start from the user's evidence-action-result path. Never start from the available
> fields, model outputs, audit labels, or internal taxonomy. Available data is an
> implementation input, not an information architecture.

For a concrete recorded failure (seven patch attempts that never fixed the task model), read `task-design-failure-case-study.md`.

## Contents

- [1. Frame the path](#1-frame-the-path)
- [2. Hard budgets](#2-hard-budgets)
- [3. Compose content and hierarchy](#3-compose-content-and-hierarchy)
- [4. Copy rules](#4-copy-rules)
- [5. Visual concept](#5-visual-concept)
- [6. Model interaction and reachable states](#6-model-interaction-and-reachable-states)
- [7. Implement the complete path](#7-implement-the-complete-path)
- [8. Deletion pass](#8-deletion-pass)
- [9. Render and walk the path](#9-render-and-walk-the-path)
- [10. Fresh-eyes gate](#10-fresh-eyes-gate)
- [Stop-and-redesign triggers](#stop-and-redesign-triggers)

## 1. Frame the path

Before composing any UI, complete a path card:

```md
- Actor:                          (who, in product terms — not "the user")
- Situation and entry:
- Goal in the actor's own words:  (MANDATORY in completion report)
- Evidence required to decide:
- Current state:
- Primary action and consequence: (MANDATORY in completion report)
- Visible result and success signal: (MANDATORY in completion report)
- Uncertainty action:
- Mistake recovery:
- Interruption and resume:
- Completion and next step:
- Route and starting fixture:
- Viewports to inspect:
```

The three MANDATORY fields must appear verbatim in the completion report. If the goal, primary action, or success signal cannot be written **without internal terminology**, the task is not framed yet — do not proceed to components.

Inspect existing routes, components, content, design tokens, data contracts, reachable states, screenshots, tests, and explicit constraints. Preserve established product decisions and record the reason for each intentional change.

When the actor, required evidence, primary action, action consequence, success signal, or consequential branch remains materially unclear after inspection, pause composition and ask the user one focused question as the complete response for that turn.

## 2. Hard budgets

These are verifiable limits, not style advice. Check them mechanically; do not self-grade them as judgment calls.

1. **Exactly one primary action per view.** One visually dominant control. Every other control is secondary or tertiary (outline, ghost, text, menu). Two "important" buttons means the path card is unresolved.
2. **Initial view interactive-element cap: 5** (buttons, links, inputs, toggles visible without scrolling), excluding global navigation. Dense professional tools may exceed this only with a recorded reason in work notes.
3. **Zero invented encodings.** No color, icon, tone, or abbreviation whose meaning must be learned from a legend before the primary action makes sense. One neutral emphasis ("this is the moment/object to judge") is allowed. A distinct encoding is allowed only when the distinction itself is what the user must decide on.
4. **Zero internal identifiers in visible copy.** See [Copy rules](#4-copy-rules) for the ban list.
5. **Evidence, question, and action co-located.** Whatever the user must look at to decide and the control that records the decision stay in one working view at both target and narrow viewports.

## 3. Compose content and hierarchy

- Use realistic domain content to shape the page before choosing components.
- Arrange the initial view in task order: purpose → current state → evidence → primary action → expected result → recovery.
- Show decision evidence in its native medium: real chart for chart judgment, real audio for music judgment, synchronized playback for timing judgment, both states together for comparison, the actual editable object for editing. Counts, ticks, and summaries are secondary orientation, never the evidence.
- Keep the default path minimal: only prerequisites for the primary action in the initial view. Diagnostics, raw data, alternative modes, and research detail go behind a deliberate secondary entry.
- First make **one item** self-explanatory; only then design batch size, pagination, progress, and shortcuts. Reducing item count is workload design, not comprehension design — six incomprehensible tasks are still incomprehensible.
- Ground prices, counts, timelines, policies, and impact claims in supplied evidence; label sample values in fixtures.

An unfamiliar reviewer must be able to answer from the rendered initial view alone:

1. What product or task is this?
2. What must I look at, listen to, or compare?
3. What is happening now?
4. What is the primary next action?
5. What result should that action produce?

For review, comparison, labeling, moderation, generated evidence, or synchronized media, read `task-evidence-design.md` before choosing components.

## 4. Copy rules

Every visible string must serve at least one purpose: orient, describe current evidence/state, state an available action, explain what just happened, or offer recovery/continuation. A string that serves none of these is deleted in the [deletion pass](#8-deletion-pass).

**Ban list — never in visible copy** (mechanically checkable):

- `snake_case`, `camelCase`, or dotted identifiers
- raw enum values (`pending`, `abstain`, `select`, `PROCESSING`)
- ids, hashes, UUIDs
- raw ISO timestamps (`2026-07-12T05:53:34Z`)
- schema/storage/pipeline nouns, prompt or model terminology, confidence semantics
- meaningless headings: `Data`, `Info`, `Details`, `Item 1`, `Section`

**Comment-copy test:** read every visible string as a first-time user. Rewrite or delete anything that reads like a code comment, schema field label, experiment note, commit message, or spec fragment.

Transformation examples (adapt to the product's domain language; do not apply mechanically):

| Internal or comment-like copy | User-facing direction |
|---|---|
| `자동 판단을 보류한 것이 맞나요?` | Ask about visible evidence: `이 소리를 따라가는 노트가 있었나요?` |
| `채보 행동`, `음악 후보` | The familiar object: `노트`, `공식 채보` — or no label at all |
| `고정 표본 42개 중 3번` | Bounded current session, shown after one item is understandable |
| `판정 저장됨` | `답을 저장했습니다.` |
| `pending` / `abstain` | `잘 모르겠어요` / `나중에 다시 볼게요` |
| `현재 항목의 noteKinds: [tap, hold]` | Show the actual notes |

## 5. Visual concept

Explore distinct directions internally, then commit to one concept grounded in the product:

```md
- Context anchors: domain object, ritual, environment, audience, or brand trait
- Concept sentence: one sentence connecting the anchors to the experience
- Expression: typography, composition, color or material, imagery, motion
- Signature: one memorable detail that belongs to this product
- Restraint: conventions that keep the primary task familiar
```

- Reuse the local design system when it carries product authority; extend through existing tokens and patterns.
- Compose from established layout conventions (list, card grid, master-detail, header + content + action bar). Do not invent a novel layout structure — novelty is a cost in task UI, not a value.
- Keep task hierarchy legible at every viewport.

## 6. Model interaction and reachable states

Cover the states the changed path can enter:

```md
State -> Trigger -> Visible meaning -> Available action -> Recovery or resume
```

Choose among default, in-progress, success, first-use empty, no-results, error, permission, and offline states according to actual behavior. Give every included state a clear meaning, useful action, and visible transition. If evidence can be genuinely ambiguous, provide a plain uncertainty action — do not force a guess or hide uncertainty behind an internal status.

## 7. Implement the complete path

- Semantic structure, accessible names, visible labels, logical focus order, readable contrast, keyboard operation.
- Preserve user input across recoverable failures when safe.
- Immediate feedback for consequential actions.
- Respect reduced-motion preferences when motion is present.
- Responsive behavior around the content and task, not a named device.

## 8. Deletion pass

Run this as a separate step after implementation, before verification.

1. List every visible element of the rendered initial view (text, control, badge, icon, divider, metric).
2. Map each element to exactly one purpose: orientation / current state / evidence / primary action / expected result / recovery-resume / prerequisite input.
3. Any element with no mapping: **delete it**, or move it behind a deliberate secondary entry if a named actor genuinely needs it.
4. Record the deleted/demoted list in the completion report.

An empty deletion list on a first draft means the pass was skipped, not that the draft was perfect. Adding is easy; this step exists because nothing else forces removal.

## 9. Render and walk the path

Use the real rendered interface as the completion gate:

1. Start from a realistic route and state.
2. Complete the primary action with the actual control.
3. Observe feedback, dependent relationships, and the success state. Verify product verbs as observed state transitions (selection→preview, edit→result, action→feedback, error→recovery, save→resume, media→visualization sync). A loaded component is not a working relationship.
4. Exercise a consequential recovery or resume path when relevant.
5. Inspect keyboard operation and focus.
6. Inspect the target viewport and a materially narrower viewport; confirm evidence and action remain co-located.
7. Read every visible string as a first-time user; re-check the copy ban list.
8. Check browser errors, overflow, clipping, contrast, and state transitions.
9. Confirm the hard budgets still hold after all changes.

Record the command, route, starting state, viewports, path walked, feedback observed, recovery path, keyboard result, browser errors, and screenshot locations.

## 10. Fresh-eyes gate

The implementer must not be the one who certifies comprehension — the builder always answers "would a stranger understand this?" with yes. Comprehension is certified by a reviewer with **no implementation context**.

Prepare a fresh-eyes packet (see `fresh-eyes-review.md` for the exact reviewer protocol):

```md
- Persona: one line — who the actor is, in product terms only
- Screenshots: rendered initial view at target and narrow viewports
  (plus the post-primary-action view when feedback matters)
- Route or URL if the reviewer can render it live
```

The packet must NOT contain the brief, the path card, design rationale, or any explanation of the interface.

- When the environment has a dispatcher or orchestrator: report status `IMPLEMENTED, FRESH-EYES PENDING` with the packet location, and let the dispatcher run an independent reviewer.
- A fresh-eyes FAIL is a comprehension failure: return to the path card and recompose (see stop triggers below). Do not patch it with copy, tooltips, or legends.
- Use `VERIFIED` only after both the rendered walkthrough and the fresh-eyes review pass. Use `IMPLEMENTED, RENDER VERIFICATION PENDING` while render access remains blocked, and include the blocker and remaining checks.

## Stop-and-redesign triggers

Stop local patching and return to the path card when any of these occurs:

- the user (or fresh-eyes reviewer) asks what they are supposed to do;
- the primary action makes sense only after reading a legend or learning an internal category;
- real evidence is replaced by prose, counts, logs, or metadata;
- evidence and answer controls cannot be seen together;
- related audio, animation, chart, preview, or state does not update together;
- the same interaction receives a second explanatory copy patch;
- reducing batch size is being used as the fix for confusion;
- a successful build or static screenshot is being offered as proof of interactive behavior.

Response procedure: acknowledge the structural failure, stop adding tooltips and paragraphs, restate the actor's goal in one sentence, identify the native evidence, remove internal concepts from the default path, recompose evidence-action-result, walk the rendered path again, and re-run the fresh-eyes gate.

## Research basis

- `task-design-failure-case-study.md` (recorded incident, 2026-07-12)
- [GOV.UK: Learning about users and their needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs)
- [NN/g: 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [W3C: WCAG 2.2](https://www.w3.org/TR/WCAG22/)
