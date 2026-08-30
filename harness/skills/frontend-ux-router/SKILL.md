---
name: frontend-ux-router
description: "화면·플로우·대시보드 만들 때. 초안, UX, 랜딩."

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
7. **Walk the rendered path** — entry, primary action, feedback, recovery, resume — at target and narrow viewports. A build or a static screenshot is not proof of interactive behavior.
8. **Fresh-eyes gate**: comprehension is certified by a reviewer with zero implementation context (`references/fresh-eyes-review.md`), never by the implementer. `VERIFIED` requires a recorded PASS.
9. **Comprehension failure → redesign, not patching.** When a user or reviewer asks what to do, return to the path card. Do not add tooltips, legends, or explanatory paragraphs to a wrong task model.

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

## Routing rules

- Treat creation and redesign as integrated product work, even when the request is phrased as a visual direction.
- Preserve approved flows, copy, states, routes, and design-system constraints.
- Inspect the current product and supplied evidence before selecting additional research.
- Load state patterns when asynchronous behavior, recovery, permissions, onboarding, or offline behavior affects the path.
- Read the failure case study when building review/labeling surfaces, exposing model output or generated evidence, or after any report that the page is confusing.
- Use the full heuristic guide for audits and launch reviews; use the creation workflow's gates for implementation work.
- Express qualities such as premium, trustworthy, calm, playful, or fast through a context-specific visual and interaction system.
- Let `references/frontend-creation.md` control user-flow clarification, budgets, copy rules, reachable states, and completion evidence when specialist guidance differs.

## Clarification gate

- Pause before composing when the actor, required evidence, primary action, action consequence, success signal, or consequential branch remains materially unclear.
- Treat ambiguity about sending, publishing, charging, deleting, approving, reserving, committing, or undoing as a blocking flow choice.
- Ask the user one focused question and wait; return the question as the complete response for that turn. When the dispatch brief explicitly grants assumption authority, record `[Assumption]` in work notes and proceed instead.
- Use working assumptions for reversible visual details that preserve the confirmed task flow.

## Completion

- Claim completion only after walking the affected path in the rendered interface from entry through action, feedback, relevant recovery, and completion — at the target viewport and a materially narrower one, including keyboard and focus.
- Include in the report: the three mandatory path-card fields (goal, primary action, success signal), the deletion-pass list, hard-budget confirmation, walkthrough evidence, and the fresh-eyes packet location or verdict.
- Status ladder: `IMPLEMENTED, RENDER VERIFICATION PENDING` (render blocked; include blocker) → `IMPLEMENTED, FRESH-EYES PENDING` (walkthrough done, packet ready) → `VERIFIED` (walkthrough + fresh-eyes PASS on record).

For an audit or design decision, report the user goal, observed friction, recommended change, material state or heuristic risks, and remaining evidence gaps.
