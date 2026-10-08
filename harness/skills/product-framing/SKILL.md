---
name: product-framing
description: "Decide the next investment or build scope for a product, hackathon or contest entry: user, current alternative, value, experiment and approval. Owns product kickoff, value drift and changes to a frozen frame. Does not turn open discussion or everyday choices into a product checklist."
metadata:
  experiment: co-thinking-v0.3
---

# Decide the product's next investment and approval scope

Work out together who is doing what at which moment, what should change, and how far the next step will investigate or build.
The checklist does not certify that the product will succeed. It is the material for approving the next learning investment or a defined build scope.
Do not bend results to prove the current plan.

Use this skill when the product is about to commit real time, resources or outside promises to its next step.
If the conversation is still exploring questions and experiences, keep it a conversation; this skill is not needed yet.
Product work does not mean rewriting every field from scratch each time. Start from the active documents and what actually changed.

## Help with product judgment while keeping approval authority where it is

Keep the user's original idea and the owner's candidates distinct, and compare them by what a real person can do differently at a given moment. An empty input field getting filled is a change in behavior. Being able to explain a new judgment from what was already written is a candidate for use value. Do not count one as proof of the other.

The model investigates checkable facts, points out contradictions and makes reasoned recommendations. The user decides personal experience, values and material commitments. The user being convinced does not prove an outside fact, and the model writing something does not make it E0 evidence. Keep the source of a proposal, its evidence grade, its adoption and permission to execute separate.

When other candidates differ only in name and share the same premise, use `metaframe`; when the product concept itself needs fresh research, use `product-reframing`. Keeping the current direction and doing nothing are also comparable options.

Check a new objection against the facts; do not repeat the same objection without new evidence. Record remaining disagreement separately from what is currently adopted. Do not waive the approval and protection conditions below just to close the conversation.

## Decide the scope of the next investment

Look first at which risks and commitments apply. Do not downgrade because of the timeline or because the user calls it an "experiment."

| Tier | Default condition | Allowed outcome |
|---|---|---|
| PROBE | Disposable internal experiment with no outside loss and no real personal data, payments or operating commitments | PASS-PROBE allows only that experiment |
| STANDARD | Outside evaluation, parallel building, substantial build investment, etc. | PASS-BUILD allows the defined build scope |
| COMMITMENT | Includes any of: real personal or sensitive data, paying customers, automated decisions that can cause harm, contracts, ongoing operation | Requires per-risk approval and the production appendix |

Exact applicability conditions and document state transitions follow `references/02-tiers-and-verdicts.md`.
Do not average a high-risk condition with low-risk items. Do not route product release or execution approval through an experiment approval.

## Distinguish experiments that discover criteria from experiments that confirm a stated claim

Record the experiment kind as `validation` or `discovery` in the existing checklist §6 field `experiment_kind`.
This does not create a new approval tier or document state.

`validation` fixes the claim under judgment, competing explanations and PASS/FAIL criteria in advance.
Do not change the criteria after seeing results to rewrite that cycle as a success.

`discovery` is for when the important judgment criteria only become known by experiencing something directly.
Write down in advance who will experience which scene, which difference will be compared, how much will be built and what will be observed,
what will not be touched, and the stop, time and cost conditions. Safety, data and scope conditions stay fixed.
Mark product success criteria that are not yet known as "still forming"; do not invent numbers for them.
Record a cycle's result as observations, newly visible differences and the next decision. Do not call finishing an exploration a product success.
To claim an outcome later, set criteria in advance in a separate confirmation cycle and test them.

For both kinds, check that the thing can actually be built or observed. Distinguish uncertainty about user value, technical feasibility,
and problems where the feel cannot be observed, and pick tools and approach accordingly. See `references/03-cheap-tests.md`.
`discovery` cannot waive COMMITMENT protections or STANDARD's public claims and independent review.

## Write the checklist and judge it

For an actual investment decision use `templates/gate.md`; for the purpose of each field use `references/01-gate-fields.md`.
Connect the product's user and scene, the current alternative, the desired change, the uncertainty that would change the choice, and the scope.
Leave unknown fields honestly unknown. The model may research and write what is needed;
the user confirms their own judgment and material commitments instead of rewriting every field.

PROBE checks §1, 2, 3, 6, 7 and the conditions for its experiment kind. What matters is that the following content exists, not the format.

- A concrete person and scene, and a current alternative or a current behavior that will actually be observed.
- The desired change is not expressed only as code or a number of screens.
- For a confirmation experiment: claim, competing explanation and criteria set in advance. For a discovery experiment: the exploration question, the scenes compared and the observation method.
- Boundaries for the work and data, stop/time/cost conditions, and user approval.

If the user or the current behavior itself is still being found, go back to conversation and observation first. Do not judge that state as
a failed person or a bad idea; explain that a build approval document is not needed yet.

STANDARD keeps every field, evidence for the claims that apply, and independent review.
Do not grant build approval when there is no concrete user and moment, the problem is written only as the absence of a solution,
there is no current alternative or desired change, organizer dependence is named without substance, related documents contradict each other, or risks and observation methods are missing.
COMMITMENT additionally needs the per-risk approvals in §9 and the required operation, failure and rollback items.
`references/02-tiers-and-verdicts.md` is canonical for the detailed conditions.

## Independent review and decision

The primary owner holds the conversation with the user. Delegate reviews whose value is independence, and research that can genuinely be split off.
STANDARD and above keep an independent red team and an independent blind review by people who did not take part in writing.
If those are unavailable, record the user's exception approval and reason as the existing rules require, or hold. A helper switching roles
does not count as independent review. Review findings are evidence, not a substitute for the user's strategic judgment and approval authority.

Give reviewers the original idea, the current document, the cited material, execution constraints and the experiment kind.
Make sure a discovery experiment is not mistaken for product success validation. Conversely, do not hide missing protections under the name of discovery.
Record acceptance or rejection of each finding with its reason in the existing §8. Do not average scores to pass a protection condition.

## Build after approval, and re-judge when new experience arrives

Do not start state-changing build work before the user approves.
Reversible preparation that was separately approved may proceed within that scope.
PASS-PROBE applies only to the defined experiment and its limits; PASS-BUILD and FRAME_LOCK apply to their build scope.

Put the actual document at `docs/frame/<frame_id>.md` and the provided original idea at `docs/frame/raw-brief-<frame_id>.md`.
If an authoritative file already preserves the original idea, reference it without distorting the original text.
The short PROBE path and the conditions for skipping `FRAME_LOCK` follow the existing contract.

Implementers do not make the user define the product again. `dispatching` passes fixed conditions and provisional methods separately.
Screens and interaction feel follow the owner's actual-run verification and the user-judgment rules.

Learning inside variable elements updates the §6 cycle. Keep earlier results reachable through `prior_cycle_ref`;
new criteria apply to future judgments and do not turn a past failure into a pass.
When an invariant has to change, get the user's decision with `templates/reopen-request.md`.
Do not lift a freeze on a worker's judgment or on a guess that "the user will like it."
Exact transitions follow `references/04-lock-and-reopen.md`.

## Read material only as far as needed

- Reasons and examples for each field: `references/01-gate-fields.md`.
- Tiers, verdicts, evidence grades and output contract: `references/02-tiers-and-verdicts.md`.
- Pre-build checks and conditions per experiment kind: `references/03-cheap-tests.md`.
- Freezing, new cycles and changes to a freeze: `references/04-lock-and-reopen.md`.
- Design background: `references/05-why-this-shape.md`. Past retrospectives do not replace the current approval rules.

Keep verdicts and important original text traceable in internal work records.
Tell the user only as much as they need: what to choose, why, and what is currently approved.
Do not recite internal role names, evidence grades or the checklist format as if they were everyday conversation.
