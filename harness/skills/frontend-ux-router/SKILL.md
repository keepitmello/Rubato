---
name: frontend-ux-router
description: "Building screens, flows, dashboards. Drafts, UX, landing pages."

---

# Frontend UX Router

Start from the affected user path.

> Frontend implementation is not the act of placing available data on a screen. It is
> arranging real evidence, a comprehensible action, visible feedback, and recovery so
> a user completes a goal without learning the implementation first.

For frontend creation, redesign, or implementation, read `references/frontend-creation.md` first. Add one specialist reference when it changes a material decision. Add a second for a separate material risk.

## Non-negotiables

These hold even when no reference is loaded. They are checks, not aspirations.

1. **Path card before components.** Write the actor, goal in the actor's own words, primary action, and success signal before composing UI. If any of these needs internal terminology, stop and reframe.
2. **One primary action per view**, visually dominant. Everything else is secondary.
3. **Initial view answers, without coaching:** what is this task, what do I look at, what is happening now, what do I do next, what will happen after.
4. **No internal language in visible copy**: no snake_case/camelCase identifiers, raw enum values, ids, raw timestamps, schema or pipeline nouns, or headings like `Data`/`Info`. If a string reads like a code comment, rewrite or delete it.
5. **Native evidence, co-located with the action.** Show the thing being judged (real chart, real audio, both comparison states, the actual editable object) next to the question and its controls. Summaries and counts are not evidence. No invented color/tone/icon codes that need a legend.
6. **Deletion pass after implementation**: map every visible element to a purpose; delete or demote unmapped elements; report the deleted list.
7. **Walk the rendered path** (entry, primary action, feedback, recovery, resume) at target and narrow viewports. A build or a static screenshot is not proof of interactive behavior.
8. **Fresh-eyes gate certifies comprehension only.** A reviewer with zero implementation context (`references/fresh-eyes-review.md`) answers "does a stranger understand what to do"; never the implementer. `VERIFIED` requires a recorded PASS. It does not certify look, feel, comfort, or taste; see rule 10.
9. **Comprehension failure → redesign, not patching.** When a user or reviewer asks what to do, return to the path card. Do not add tooltips, legends, or explanatory paragraphs to a wrong task model.
10. **The user is the only sensor for look and feel.** Beauty, naturalness, comfort, and "does this feel like the product" are judged by the user on the rendered screen and by nothing else: not by tests, not by the implementer, not by any reviewer, not by a fresh-eyes PASS. Put the user in the loop, not at the end of it: one implementation turn ends at the *smallest runnable result the current judgment needs*. For layout or mood that is a correctly rendered screen; for a transition or camera it is a running clip; for control feel it is a short segment the user can operate. Getting there includes fixing your own build errors, missing states, and half-drawn layout, as many edits as it takes. After that, continue only on the user's feedback or inside a scope the user opened beforehand ("do the rest the same way"); delivering the result, silence, and an automatic continue prompt are not approval. If you have no channel to the user, this is a return, not a wait: end the turn with the result, the two or three points to judge, and what you did not build yet; resumption arrives as a new task. If your brief asks for several visual surfaces in one uninterrupted run, return after the first one and say the rest is waiting on a verdict.
11. **Nothing outside the agreed composition.** Every element on screen traces to something the user asked for, approved, or that the path can actually enter. States the changed path can reach (loading, empty, error, permission, offline) are part of the composition, not additions; see `references/frontend-creation.md` §6. A defect is a *new surface or new content*: a safety banner, a disclaimer, a picker screen, an explanatory sentence, a state for a flow that cannot occur. It is a defect even when it is well made. If you believe something is missing, say so in the report; do not build it. When an approved composition breaks a hard budget (two primary actions, more than five interactive elements), resolve it by demotion, never by deletion, and report the demotion as a change to what was approved.
12. **A frozen value is a check, not a sentence.** When the user locks a number, a feel, a layout, or a composition ("keep this", "freeze this", "do not touch"), protect it at the strongest level available: a number or token → an assertion that fails when it changes; a layout or composition → a snapshot or contract check; a feel that no check can express → one named definition site with the marker, plus a line in your return. Mark the source at the point of definition ("frozen, user, 2026-08-14"). If you cannot write the check (no test surface, or the file is outside your write scope), return the frozen item as an unprotected gap with the reason; do not report it as protected. Prose in a document does not protect anything: a later worker will not read it, or will read it and let the task win. Leaving the old value in a comment while replacing the mechanism that uses it is a violation, not compliance.
13. **Machine PASS is regression protection, not product judgment.** Contract checks, automated walkthroughs, hashes, and snapshot tests say "nothing regressed on what they measure". Report them with that scope written next to them ("PASS: world contract, auto-flight; product verdict: not yet judged by user"). Never let a green check, a one-word `Ready`, or a reviewer's approval stand in the product verdict column.
14. **Same surface rejected twice on feel → suspect the layer, not the pixels.** When the user rejects the same surface a second time with a feel word ("cluttered", "messy", "feels like a feature, not the product", "looks copied"), do not make a third pass of the same kind. Re-judge the cause first, and name which one it is: the surface's role sentence (what it is for, in the user's words), the implementation approach (the composition or rendering method), or the tool or engine underneath. Fix at that layer. When the cause is the role, rewrite the sentence and get it past the user before touching a pixel; without a user channel, the cause judgment and the proposed fix, not a tuned screen, are the deliverable of that turn. The count is per cause fix: once the user accepts the fix at the named layer, the count resets to zero.

## Route

| Primary need | Read |
|---|---|
| New page, flow, dashboard, landing page, first draft, redesign, or combined UX and visual implementation | `references/frontend-creation.md` |
| Review, labeling, comparison, moderation, generated evidence, synchronized media, private encodings, or repeated task confusion | `references/task-evidence-design.md` |
| Concrete failure example: data-first screen, comment-like copy, invented encodings, seven failed patches | `references/task-design-failure-case-study.md` |
| Independent comprehension review of a built screen | `references/fresh-eyes-review.md` |
| Research question, user evidence, usability test, product validation | `references/software-ux-research/guide.md` |
| Navigation, grouping, hierarchy, labels, search, discoverability | `references/information-architecture/guide.md` |
| Loading, empty, success, error, permission, offline, onboarding, notifications | `references/performance-states-patterns/guide.md` |
| UX audit or launch review of an existing flow | `references/nng-ux-heuristics/guide.md` |
| Product UI layout, spacing, typography, color, icons, component polish | `references/visual-product-ui.md` |
| Landing, hero, marketing, portfolio, expressive visual direction | `references/creative-frontend-design.md` |
| Frontend code review against interface guidelines | `references/web-interface-guidelines.md` |
| Several screens over several days (3+ surfaces, more than one session) | `references/multi-screen-sequence.md` |

## Routing rules

- Treat creation and redesign as integrated product work, even when the request is phrased as a visual direction.
- Preserve approved flows, copy, states, routes, and design-system constraints.
- Inspect the current product and supplied evidence before selecting additional research.
- Load state patterns when asynchronous behavior, recovery, permissions, onboarding, or offline behavior affects the path.
- Read the failure case study when building review/labeling surfaces, exposing model output or generated evidence, or after any report that the page is confusing.
- Use the full heuristic guide for audits and launch reviews; use the creation workflow's gates for implementation work.
- Express qualities such as premium, trustworthy, calm, playful, or fast through a context-specific visual and interaction system.
- Let `references/frontend-creation.md` control user-flow clarification, budgets, copy rules, reachable states, visual-concept exploration, and completion evidence when specialist guidance differs.
- Comparison variants (A/B/C mockups, parallel implementations) are a method for choosing parts, not a vote for a winner. Expect the user to take the body of one, the spacing of another, and the copy of a third. Present variants so parts can be pointed at; do not build one variant to completion expecting whole adoption.
- Mood, scale, and whitespace are agreed on a generated image before code when the product has no visual language yet. Vary one variable per image (three images, one variable), let the user pick, then implement. Code is not the place to discover mood.

## Clarification gate

- Pause before composing when the actor, required evidence, primary action, action consequence, success signal, or consequential branch remains materially unclear.
- Treat ambiguity about sending, publishing, charging, deleting, approving, reserving, committing, or undoing as a blocking flow choice.
- Ask the user one focused question and wait; return the question as the complete response for that turn. When the dispatch brief explicitly grants assumption authority, record `[Assumption]` in work notes and proceed instead.
- Use working assumptions for reversible visual details that preserve the confirmed task flow.

## Completion

- Claim completion only after walking the affected path in the rendered interface from entry through action, feedback, relevant recovery, and completion, at the target viewport and a materially narrower one, including keyboard and focus. The primary viewport for judgment and screenshots is the product's primary platform: desktop for web products unless the task or the product is mobile-first; narrow viewports are then the secondary check.
- Two reports, two readers. The dispatcher report carries: the three mandatory path-card fields (goal, primary action, success signal), the deletion-pass list, hard-budget confirmation, walkthrough evidence, frozen items touched (`none`, or which and why), and the fresh-eyes packet location or verdict. The user report carries only what the user will judge: absolute paths to rendered screenshots (or a live URL) and the two or three points to look at. Do not paste command logs, test counts, or file lists into the user report. When you have one output channel, emit both under two headings in one return (`## For the dispatcher`, `## For the user`); the dispatcher forwards the user block verbatim and keeps the rest.
- Status ladder. These are labels for what is on record, not a required order: `IMPLEMENTED, RENDER VERIFICATION PENDING` (render blocked; include blocker) → `IMPLEMENTED, FRESH-EYES PENDING` (walkthrough done, packet ready) → `VERIFIED` (walkthrough + fresh-eyes PASS on record) → `USER-JUDGED` (the user has seen the rendered surface and said it is right). On a visual surface the user's first look happens at the first rendered state, before `VERIFIED`, not after it. Only `USER-JUDGED` is a product verdict, and only the session that talks to the user can record it; a dispatched worker's ceiling is `VERIFIED`.

For an audit or design decision, report the user goal, observed friction, recommended change, material state or heuristic risks, and remaining evidence gaps.
